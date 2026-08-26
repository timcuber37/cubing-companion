"""
Exports the trained rankers to ONNX, for ONNX Runtime Web.

Run: ml/.venv/bin/python ml/export.py

Two things here are not optional, both found by testing in a real browser rather than by reading
docs:

1. **`external_data=False`.** By default torch writes the weights to a `.onnx.data` sidecar and
   the model file only references it. In a browser that fails with "Module.MountedFiles is not
   available" — there is no filesystem to mount it from. The model must be self-contained.
2. **A dynamic first axis.** A decision has two to four options for pair order and can have
   hundreds for the cross, so the batch dimension cannot be baked in at export time.

Alongside each model goes a fixture of inputs and the outputs PyTorch produced for them, which
the TypeScript side asserts against. That parity test is what catches a feature-order mismatch
between training and inference — a bug whose only symptom is a model that underperforms quietly.
"""

from __future__ import annotations

import json
from pathlib import Path

import torch

from data import CHECKPOINTS, Group, Ranker, load, split_by_solver

PUBLIC = Path(__file__).resolve().parent.parent / "apps" / "web" / "public" / "models"
FIXTURE_ROWS = 256


def export(kind: str) -> None:
    checkpoint = CHECKPOINTS / f"{kind}.pt"
    if not checkpoint.exists():
        print(f"no checkpoint for {kind}; train it first")
        return

    saved = torch.load(checkpoint, weights_only=True)
    model = Ranker(saved["n_features"])
    model.load_state_dict(saved["state"])
    model.eval()

    PUBLIC.mkdir(parents=True, exist_ok=True)
    sample = torch.randn(5, saved["n_features"])

    torch.onnx.export(
        model,
        (sample,),
        str(PUBLIC / f"{kind}.onnx"),
        input_names=["features"],
        output_names=["score"],
        dynamic_axes={"features": {0: "options"}, "score": {0: "options"}},
        opset_version=17,
        external_data=False,
    )

    # Real feature vectors from held-out decisions, so the fixture exercises the ranges the model
    # will actually see rather than whatever `randn` happens to produce.
    groups = load(kind)
    _, _, test = split_by_solver(groups)
    rows: list[list[float]] = []
    for group in test:
        for option in group.options.tolist():
            rows.append(option)
            if len(rows) >= FIXTURE_ROWS:
                break
        if len(rows) >= FIXTURE_ROWS:
            break

    with torch.no_grad():
        expected = model(torch.tensor(rows, dtype=torch.float32)).tolist()

    (PUBLIC / f"{kind}.fixture.json").write_text(
        json.dumps({"input": rows, "expected": expected}, indent=None)
    )
    print(f"  {kind}: {PUBLIC / f'{kind}.onnx'}  ({len(rows)} fixture rows)")


if __name__ == "__main__":
    print("exporting:")
    for kind in ("pair", "cross"):
        export(kind)
