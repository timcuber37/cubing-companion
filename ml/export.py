"""
Exports the trained rankers for the TypeScript side.

Run: ml/.venv/bin/python ml/export.py

Two artefacts, for two different jobs:

1. **`packages/planner/src/weights.generated.ts`** — the weights themselves, as a committed
   TypeScript constant, following the `baselines.generated.ts` precedent. `packages/planner`
   evaluates the model directly (see `mlp.ts`): it is a three-layer MLP, about forty lines of
   arithmetic. This replaced ONNX Runtime Web, which fetched a 27.8 MB WASM runtime to do those
   forty lines. Bundled rather than fetched, so there is no runtime download, no asset to lose,
   and no URL for a native WebView to resolve differently.

2. **`ml/out/{kind}.onnx`** — kept because it is the portable form of a trained model and costs
   nothing to emit, but no longer shipped to the browser. `external_data=False` stays: by default
   torch writes weights to a `.onnx.data` sidecar, which fails in a browser with
   "Module.MountedFiles is not available" because there is no filesystem to mount it from.

Alongside each model goes a fixture of inputs and the outputs PyTorch produced for them, which
`packages/planner/test/mlp.test.ts` asserts against. That parity test is what catches a
feature-order mismatch between training and inference — a bug whose only symptom is a model that
underperforms quietly.
"""

from __future__ import annotations

import json
from pathlib import Path

import torch

from data import CHECKPOINTS, Group, Ranker, load, split_by_solver

ROOT = Path(__file__).resolve().parent.parent
PLANNER = ROOT / "packages" / "planner"
WEIGHTS_TS = PLANNER / "src" / "weights.generated.ts"
FIXTURES = PLANNER / "test" / "fixtures"
ONNX_OUT = Path(__file__).resolve().parent / "out"
KINDS = ("cross", "pair")
FIXTURE_ROWS = 256


def numbers(values: list[float], indent: int) -> str:
    """
    One array, wrapped to a readable width, at shortest round-trip precision.

    `repr(float(x))` on a value that came out of a float32 tensor gives the shortest decimal that
    reads back as exactly that float32 — so the generated file is lossless without being verbose.
    """
    pad = " " * indent
    parts = [repr(float(v)) for v in values]
    lines: list[str] = []
    current = ""
    for part in parts:
        candidate = f"{current}{part}, "
        if len(pad) + len(candidate) > 98 and current:
            lines.append(current.rstrip())
            current = f"{part}, "
        else:
            current = candidate
    if current:
        lines.append(current.rstrip().rstrip(","))
    if len(lines) == 1 and len(pad) + len(lines[0]) <= 96:
        return f"[{lines[0]}]"
    body = f"\n{pad}".join(lines)
    return f"[\n{pad}{body}\n{' ' * (indent - 2)}]"


def weights_of(model: Ranker, n_features: int) -> str:
    """The model as a TypeScript object literal, matching `MlpWeights` in `mlp.ts`."""
    layers: list[str] = []
    for module in model.net:
        if not isinstance(module, torch.nn.Linear):
            continue  # ReLU carries no parameters; `mlp.ts` applies it between layers.
        layers.append(
            "      {\n"
            f"        inputs: {module.in_features},\n"
            f"        outputs: {module.out_features},\n"
            # PyTorch stores Linear.weight as [out_features, in_features]; `mlp.ts` reads it
            # row-major in exactly that order, so flatten without transposing.
            f"        weight: {numbers(module.weight.detach().flatten().tolist(), 10)},\n"
            f"        bias: {numbers(module.bias.detach().tolist(), 10)},\n"
            "      },"
        )
    joined = "\n".join(layers)
    return (
        "{\n"
        f"    features: {n_features},\n"
        f"    mean: {numbers(model.mean.tolist(), 6)},\n"
        f"    scale: {numbers(model.scale.tolist(), 6)},\n"
        "    layers: [\n"
        f"{joined}\n"
        "    ],\n"
        "  }"
    )


def fixture(kind: str, model: Ranker) -> int:
    """Real feature vectors from held-out decisions, with the scores PyTorch gives them."""
    # Held-out rather than `randn` so the fixture exercises the ranges the model will actually
    # see, and so a feature-order mismatch shows up as a large disagreement rather than a small one.
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

    FIXTURES.mkdir(parents=True, exist_ok=True)
    (FIXTURES / f"{kind}.fixture.json").write_text(
        json.dumps({"input": rows, "expected": expected}, indent=None)
    )
    return len(rows)


def onnx(kind: str, model: Ranker, n_features: int) -> None:
    ONNX_OUT.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(
        model,
        (torch.randn(5, n_features),),
        str(ONNX_OUT / f"{kind}.onnx"),
        input_names=["features"],
        output_names=["score"],
        # A decision has two to four options for pair order and can have hundreds for the cross,
        # so the batch dimension cannot be baked in at export time.
        dynamic_axes={"features": {0: "options"}, "score": {0: "options"}},
        opset_version=17,
        external_data=False,
    )


def main() -> None:
    print("exporting:")
    literals: dict[str, str] = {}
    shape = ""

    for kind in KINDS:
        checkpoint = CHECKPOINTS / f"{kind}.pt"
        if not checkpoint.exists():
            print(f"  {kind}: no checkpoint; train it first")
            continue

        saved = torch.load(checkpoint, weights_only=True)
        n_features = saved["n_features"]
        model = Ranker(n_features)
        model.load_state_dict(saved["state"])
        model.eval()

        literals[kind] = weights_of(model, n_features)
        rows = fixture(kind, model)
        onnx(kind, model, n_features)
        dims = [n_features] + [m.out_features for m in model.net if isinstance(m, torch.nn.Linear)]
        shape = " → ReLU → ".join(
            f"Linear({dims[i]}, {dims[i + 1]})" for i in range(len(dims) - 1)
        )
        print(f"  {kind}: weights + {rows} fixture rows + {ONNX_OUT / f'{kind}.onnx'}")

    if not literals:
        print("nothing to export; no checkpoints found")
        return

    entries = "\n".join(
        f"  {kind}: {literals[kind]}," if kind in literals else f"  {kind}: null,"
        for kind in KINDS
    )
    names = " | ".join(f'"{kind}"' for kind in KINDS)
    WEIGHTS_TS.write_text(
        "// GENERATED FILE — do not edit by hand.\n"
        "// Regenerate with: ml/.venv/bin/python ml/export.py\n"
        f"// Source: ml/out/{{{','.join(KINDS)}}}.pt (see ml/export.py).\n"
        "//\n"
        f"// {shape},\n"
        "// with standardisation carried as buffers so raw features can be passed straight in.\n"
        "// See ml/README.md for what these were fitted on, and test/mlp.test.ts for the\n"
        "// parity check against PyTorch's own outputs.\n"
        "\n"
        'import type { MlpWeights } from "./mlp.ts";\n'
        "\n"
        "/** Which decision a ranker was trained for. */\n"
        f"export type RankerName = {names};\n"
        "\n"
        "/** `null` for a head whose checkpoint was missing when this was generated. */\n"
        "export const WEIGHTS: Readonly<Record<RankerName, MlpWeights | null>> = {\n"
        f"{entries}\n"
        "};\n"
    )
    print(f"  → {WEIGHTS_TS.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
