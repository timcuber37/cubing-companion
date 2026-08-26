"""
How good is it, and is it better than counting moves?

Run: ml/.venv/bin/python ml/eval.py [pair|cross]

`PLAN.md` sets the bar: "the model must beat 'fewest moves wins' to matter." So the baseline sits
next to every figure here rather than in a footnote, and the tied decisions — the ones where a
movecount ranker is guessing — get reported on their own. An aggregate can look healthy while the
model adds nothing exactly where it was supposed to.
"""

from __future__ import annotations

import sys

import torch

from data import (
    CHECKPOINTS,
    CROSS_FEATURES,
    PAIR_FEATURES,
    Group,
    Ranker,
    load,
    masked_scores,
    pad,
    split_by_decision,
    split_by_solver,
)
from train import baseline_accuracy


def load_model(kind: str) -> Ranker:
    saved = torch.load(CHECKPOINTS / f"{kind}.pt", weights_only=True)
    model = Ranker(saved["n_features"])
    model.load_state_dict(saved["state"])
    model.eval()
    return model


def predictions(model: Ranker, groups: list[Group]) -> torch.Tensor:
    with torch.no_grad():
        batch, mask, labels = pad(groups)
        return (masked_scores(model, batch, mask).argmax(dim=1) == labels).float()


def top_k(model: Ranker, groups: list[Group], k: int) -> float:
    with torch.no_grad():
        batch, mask, labels = pad(groups)
        scores = masked_scores(model, batch, mask)
        width = min(k, scores.shape[1])
        best = scores.topk(width, dim=1).indices
    return (best == labels.unsqueeze(1)).any(dim=1).float().mean().item()


def is_tied(group: Group) -> bool:
    """A decision move count cannot settle: two or more options share the shortest length."""
    if group.lengths is None:
        return False
    best = min(group.lengths)
    return sum(1 for length in group.lengths if length == best) > 1


def report(kind: str) -> None:
    groups = load(kind)
    if not groups:
        print(f"no {kind} decisions")
        return
    model = load_model(kind)
    names = PAIR_FEATURES if kind == "pair" else CROSS_FEATURES

    print(f"\n{'=' * 62}\n{kind.upper()} RANKER — {len(groups):,} decisions\n{'=' * 62}")

    for label, split in (("held out by solver", split_by_solver), ("random split", split_by_decision)):
        _, _, test = split(groups)
        correct = predictions(model, test).mean().item()
        baseline = baseline_accuracy(test)
        chance = sum(1 / g.options.shape[0] for g in test) / len(test)
        print(f"\n  {label}  ({len(test):,} decisions)")
        print(f"    chance          {chance:6.1%}")
        rule = "movecount" if kind == "pair" else "A4 comfort"
        print(f"    {rule:15} {baseline:6.1%}")
        print(f"    model top-1     {correct:6.1%}   ({correct - baseline:+.1%} against the baseline)")
        if max(g.options.shape[0] for g in test) > 3:
            print(f"    model top-3     {top_k(model, test, 3):6.1%}")

    # The interesting slice: where counting moves cannot choose.
    _, _, test = split_by_solver(groups)
    ties = [g for g in test if is_tied(g)]
    if ties:
        correct = predictions(model, ties).mean().item()
        print(f"\n  where move count ties  ({len(ties):,} of {len(test):,} decisions)")
        print(f"    chance          {sum(1 / g.options.shape[0] for g in ties) / len(ties):6.1%}")
        print(f"    movecount       {baseline_accuracy(ties):6.1%}")
        print(f"    model top-1     {correct:6.1%}")

    if kind == "pair":
        print(f"\n  by step")
        for step in (0, 1, 2):
            subset = [g for g in test if g.step == step]
            if not subset:
                continue
            print(
                f"    pair {step + 1}   n={len(subset):5,}   "
                f"movecount {baseline_accuracy(subset):6.1%}   model {predictions(model, subset).mean().item():6.1%}"
            )

    # Permutation importance: shuffle one feature across decisions and see what breaks. Cheaper
    # than retraining a dozen times, and it measures what the trained model actually leans on.
    print(f"\n  what the model leans on (accuracy drop when a feature is shuffled)")
    base = predictions(model, test).mean().item()
    generator = torch.Generator().manual_seed(5)
    drops = []
    for index, name in enumerate(names):
        shuffled = []
        for group in test:
            options = group.options.clone()
            order = torch.randperm(options.shape[0], generator=generator)
            options[:, index] = options[order, index]
            shuffled.append(Group(options, group.chosen, group.solver, group.step, group.lengths))
        drops.append((name, base - predictions(model, shuffled).mean().item()))

    for name, drop in sorted(drops, key=lambda item: -item[1]):
        bar = "#" * max(0, round(drop * 200))
        print(f"    {name:20} {drop:+.3f}  {bar}")


if __name__ == "__main__":
    for kind in sys.argv[1:] or ["pair", "cross"]:
        report(kind)
    print()
