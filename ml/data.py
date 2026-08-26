"""
Loading B3's decision data, and the model both heads share.

Every feature in `data/decisions.jsonl` was computed by `packages/planner/src/features.ts` — the
same TypeScript the browser runs. Nothing here computes a feature, and nothing here should ever
start to: the moment a feature is defined in two places, training and inference can disagree
without anything failing loudly.
"""

from __future__ import annotations

import json
import os
import zlib
from dataclasses import dataclass
from pathlib import Path

import torch
import torch.nn as nn

# Overridable so a partial or trimmed dataset can be trained on without editing anything.
DATA = Path(
    os.environ.get(
        "DECISIONS", Path(__file__).resolve().parent.parent / "data" / "decisions.jsonl"
    )
)
CHECKPOINTS = Path(__file__).resolve().parent / "out"

# Feature names, mirrored from features.ts purely so the writeup and the ablation can name them.
# `verify_feature_names` checks them against the TypeScript rather than trusting this copy.
PAIR_FEATURES = [
    "insertionLength",
    "excessOverBest",
    "pairDistance",
    "logWays",
    "cornerOnTop",
    "cornerInOwnSlot",
    "edgeOnTop",
    "edgeInOwnSlot",
    "backTurns",
    "adjacentToPrevious",
    "stepIndex",
    "openCount",
]

CROSS_FEATURES = [
    "length",
    "comfort",
    "turnsU",
    "turnsD",
    "turnsL",
    "turnsR",
    "turnsF",
    "turnsB",
    "halfTurns",
    "distinctFaces",
    "endsOnDown",
    "sameAxisPairs",
]


@dataclass
class Group:
    """One decision: the options a pro faced, and the one they took."""

    options: torch.Tensor  # (n_options, n_features)
    chosen: int
    solver: str
    step: int
    # Insertion lengths, kept so the movecount baseline can be recomputed at eval time.
    lengths: list[int] | None


def load(kind: str, path: Path = DATA) -> list[Group]:
    groups: list[Group] = []
    with path.open() as handle:
        for line in handle:
            row = json.loads(line)
            if row["kind"] != kind:
                continue
            groups.append(
                Group(
                    options=torch.tensor(row["options"], dtype=torch.float32),
                    chosen=row["chosen"],
                    solver=row["solver"],
                    step=row.get("step", -1),
                    lengths=row.get("lengths"),
                )
            )
    return groups


def split_by_solver(
    groups: list[Group], test: float = 0.15, val: float = 0.15
) -> tuple[list[Group], list[Group], list[Group]]:
    """
    Hold out whole solvers, not individual decisions.

    Pair order is partly personal habit, and the five most-represented solvers account for 36% of
    the corpus. Splitting by decision would let the model learn "Max Park does this" and score
    well without having learned anything transferable, which is exactly the claim being tested.
    A stable hash of the name decides the bucket, so the split does not move between runs.
    """

    def bucket(name: str) -> float:
        return (zlib.crc32(name.encode()) % 10_000) / 10_000

    train_set, val_set, test_set = [], [], []
    for group in groups:
        position = bucket(group.solver)
        if position < test:
            test_set.append(group)
        elif position < test + val:
            val_set.append(group)
        else:
            train_set.append(group)
    return train_set, val_set, test_set


def split_by_decision(
    groups: list[Group], test: float = 0.15, val: float = 0.15
) -> tuple[list[Group], list[Group], list[Group]]:
    """A plain random split, reported alongside the solver split to show what the harder one costs."""
    generator = torch.Generator().manual_seed(11)
    order = torch.randperm(len(groups), generator=generator).tolist()
    n_test = int(len(groups) * test)
    n_val = int(len(groups) * val)
    pick = lambda idx: [groups[i] for i in idx]
    return (
        pick(order[n_test + n_val :]),
        pick(order[n_test : n_test + n_val]),
        pick(order[:n_test]),
    )


class Ranker(nn.Module):
    """
    Scores one option at a time; the softmax across a decision's options makes it a ranker.

    Standardisation is a buffer inside the module rather than something the caller applies, so it
    travels into the ONNX graph. The browser then sends raw features and cannot get the
    normalisation wrong — there is no normalisation on that side to get wrong.
    """

    def __init__(self, n_features: int, hidden: int = 16, hidden2: int = 8) -> None:
        super().__init__()
        self.register_buffer("mean", torch.zeros(n_features))
        self.register_buffer("scale", torch.ones(n_features))
        self.net = nn.Sequential(
            nn.Linear(n_features, hidden),
            nn.ReLU(),
            nn.Linear(hidden, hidden2),
            nn.ReLU(),
            nn.Linear(hidden2, 1),
        )

    def forward(self, features: torch.Tensor) -> torch.Tensor:
        return self.net((features - self.mean) / self.scale).squeeze(-1)

    def fit_normalisation(self, groups: list[Group]) -> None:
        stacked = torch.cat([group.options for group in groups])
        self.mean.copy_(stacked.mean(0))
        # A constant feature would divide by zero; leave those alone rather than exploding them.
        self.scale.copy_(stacked.std(0).clamp(min=1e-6))


def pad(groups: list[Group], cap: int | None = None) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    """
    Pack variable-sized decisions into one batch.

    `cap` subsamples the negatives of very large decisions during training — a cross with 300
    optimal solutions would otherwise dominate a batch — while eval always runs uncapped, because
    top-1 against a trimmed candidate set would be a flattering and meaningless number.
    """
    prepared = []
    for group in groups:
        options, chosen = group.options, group.chosen
        if cap is not None and options.shape[0] > cap:
            others = [i for i in range(options.shape[0]) if i != chosen]
            keep = torch.randperm(len(others))[: cap - 1].tolist()
            index = [chosen] + [others[i] for i in keep]
            options, chosen = options[index], 0
        prepared.append((options, chosen))

    width = max(options.shape[0] for options, _ in prepared)
    n_features = prepared[0][0].shape[1]
    batch = torch.zeros(len(prepared), width, n_features)
    mask = torch.zeros(len(prepared), width, dtype=torch.bool)
    labels = torch.zeros(len(prepared), dtype=torch.long)

    for i, (options, chosen) in enumerate(prepared):
        n = options.shape[0]
        batch[i, :n] = options
        mask[i, :n] = True
        labels[i] = chosen
    return batch, mask, labels


def masked_scores(model: Ranker, batch: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
    """Padding must not be selectable, so it is pushed to negative infinity before the softmax."""
    scores = model(batch)
    return scores.masked_fill(~mask, float("-inf"))
