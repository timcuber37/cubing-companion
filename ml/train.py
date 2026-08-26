"""
Trains the B3 rankers.

Run: ml/.venv/bin/python ml/train.py [pair|cross]

Listwise, not pointwise: the loss is a softmax over the options a pro actually faced, scored
against the one they took. That matches the question being asked — "which of these would a pro
pick" — and it makes the model indifferent to any constant offset in its scores, which is the
right invariance for a ranker.
"""

from __future__ import annotations

import sys
import time

import torch
import torch.nn.functional as F

from data import (
    CHECKPOINTS,
    CROSS_FEATURES,
    Group,
    Ranker,
    load,
    masked_scores,
    pad,
    split_by_solver,
)

EPOCHS = 200
BATCH = 256
PATIENCE = 20
TRAIN_CAP = 32  # negatives kept per decision while training; eval is always uncapped


def accuracy(model: Ranker, groups: list[Group]) -> float:
    if not groups:
        return float("nan")
    model.eval()
    with torch.no_grad():
        batch, mask, labels = pad(groups)
        picked = masked_scores(model, batch, mask).argmax(dim=1)
    return (picked == labels).float().mean().item()


# Position of `comfort` in CROSS_FEATURES — A4's heuristic, which is the cross head's baseline.
COMFORT_INDEX = CROSS_FEATURES.index("comfort")


def baseline_accuracy(groups: list[Group]) -> float:
    """
    The rule B3 has to beat, which is a different rule for each head.

    **Pair order: "fewest moves wins."** Ties are settled by splitting the credit rather than by
    taking the first, which would only measure an accident of slot ordering. So this is the score
    of a ranker that knows move count and guesses uniformly when move count cannot separate the
    options — the honest version of the bar `PLAN.md` sets.

    **Cross: A4's comfort model.** Every candidate there is already optimal length, so move count
    says nothing at all. The standing rule is the unigram face-frequency score that ships in
    `planner`, and using it here makes the comparison the one that matters: is the learned model
    better than the heuristic already in the product?
    """
    if not groups:
        return float("nan")

    total = 0.0
    for group in groups:
        if group.lengths is not None:
            scores = [-length for length in group.lengths]
        else:
            scores = group.options[:, COMFORT_INDEX].tolist()
        best = max(scores)
        winners = [i for i, score in enumerate(scores) if score == best]
        if group.chosen in winners:
            total += 1 / len(winners)
    return total / len(groups)


def train(kind: str) -> None:
    groups = load(kind)
    if not groups:
        print(f"no {kind} decisions in the dataset")
        return

    train_set, val_set, test_set = split_by_solver(groups)
    n_features = groups[0].options.shape[1]
    print(
        f"{kind}: {len(groups):,} decisions "
        f"({len(train_set):,} train / {len(val_set):,} val / {len(test_set):,} test, "
        f"held out by solver), {n_features} features"
    )

    model = Ranker(n_features)
    model.fit_normalisation(train_set)
    optimiser = torch.optim.Adam(model.parameters(), lr=3e-3, weight_decay=1e-4)

    best_val, best_state, since_best = -1.0, None, 0
    started = time.time()

    for epoch in range(EPOCHS):
        model.train()
        order = torch.randperm(len(train_set)).tolist()
        for start in range(0, len(order), BATCH):
            chunk = [train_set[i] for i in order[start : start + BATCH]]
            batch, mask, labels = pad(chunk, cap=TRAIN_CAP)
            loss = F.cross_entropy(masked_scores(model, batch, mask), labels)
            optimiser.zero_grad()
            loss.backward()
            optimiser.step()

        val = accuracy(model, val_set)
        if val > best_val:
            best_val, since_best = val, 0
            best_state = {k: v.clone() for k, v in model.state_dict().items()}
        else:
            since_best += 1
            if since_best >= PATIENCE:
                print(f"  stopping at epoch {epoch}; no improvement for {PATIENCE}")
                break
        if epoch % 10 == 0:
            print(f"  epoch {epoch:3d}  loss {loss.item():.4f}  val top-1 {val:.4f}")

    assert best_state is not None
    model.load_state_dict(best_state)

    CHECKPOINTS.mkdir(exist_ok=True)
    torch.save({"state": model.state_dict(), "n_features": n_features}, CHECKPOINTS / f"{kind}.pt")

    print(f"\n  trained in {time.time() - started:.0f}s")
    print(f"  val  top-1 {best_val:.4f}")
    print(f"  test top-1 {accuracy(model, test_set):.4f}   baseline {baseline_accuracy(test_set):.4f}")
    print(f"  saved {CHECKPOINTS / f'{kind}.pt'}")


if __name__ == "__main__":
    for kind in sys.argv[1:] or ["pair", "cross"]:
        train(kind)
        print()
