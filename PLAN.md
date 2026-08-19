# Speedcube Coach — Project Plan

*(Working name — rename freely; folder can become the repo root.)*

An app built on a virtual cube synced to a physical smart cube, that analyzes your
solves, scores them against how the world's best actually solve, and shows you what
a top solver would have done from your exact position. The ML core is **imitation
learning of expert human solving style** from solve reconstructions — NOT an
"optimal solver" (classical solvers own that; the interview answer for "why ML?"
is exactly this distinction).

## Scope guard

- 3x3 **CFOP only** until further notice. No Roux/ZZ, no big cubes, no OH.
- Web app, Chrome/Edge desktop + Android first. **No iOS** (Web Bluetooth doesn't
  exist on iOS Safari; native wrapper is a someday-item).
- Algorithm trainer: parked until the foundation ships. Commodity feature.
- The analysis engine is **input-agnostic**: smart cube stream, typed/pasted
  reconstruction, and file import all feed one pipeline. Smart cube is an input
  adapter, never a dependency of the analysis code. (Also makes everything
  testable in CI without hardware.)

## Architecture decisions (made up front)

- **Stack**: Next.js + TypeScript (existing lead stack). Cube engine and analysis
  in pure TS modules; solvers in Web Workers (WASM where needed).
- **Rendering/notation**: `cubing.js` (twisty player, alg parsing, scrambles).
  Internal state = piece permutation/orientation arrays for fast predicates —
  the twisty player is display-only, never the source of truth.
- **Smart cube**: adapter interface (`connect / onMove(move, timestamp) /
  queryState / onDisconnect`). First implementation = the protocol for the cube I
  own, via `gan-web-bluetooth` or equivalent open protocol lib; csTimer's
  open-source drivers as protocol reference (GPL — reference, don't paste, unless
  the app is GPL too).
- **ML**: PyTorch (deliberately diversifying from TensorFlow/PKC). Serve via ONNX
  Runtime Web in-browser — zero serving cost, offline-capable, Vercel-friendly.
- **Timestamps**: smooth/bucket BLE move timestamps before any TPS/pause metric;
  expect batching jitter. Re-sync state via cube state query on desync.

## Track A — App / platform

### A0. Cube engine foundation (1–2 weekends)
- Repo, CI, state representation (permutation + orientation), move applier,
  notation parse/serialize (incl. rotations, wide, slice), scramble gen.
- Property tests: scramble + its solution ⇒ solved; round-trip notation; every
  reconstruction in the corpus verifies (shared with B1).
- **Deliverable:** tested engine package. Everything else imports it.

### A1. Smart cube link + virtual cube (1–2 weekends)
- BLE adapter for my cube; live mirror on the twisty player with timestamps;
  desync recovery (state query + re-seed); manual input mode (keyboard + paste).
- **Deliverable:** turn the physical cube, watch the virtual one follow.

### A2. Solve capture + phase segmentation (1 weekend)
- Record sessions (scramble, moves, timestamps). Segment CFOP phases from state
  predicates: cross (any color), xcross detection, F2L pairs 1–4, OLL, PLL, AUF.
  Handle edge cases (pseudoslotting, keyhole, OLL/PLL skips).
- Storage: local-first (IndexedDB), sync later (Turso/Postgres — existing pattern).
- **Deliverable:** segmented solve records. Segmenter is shared with B1.

### A3. Analysis + scoring (1–2 weekends)
- Per phase: movecount, TPS, rotations, recognition vs execution split, pause
  detection (gap threshold between move bursts), longest pause, fluidity.
- Composite solve score = **percentiles vs the pro corpus distributions** (needs
  B1; ship with heuristic bands first, swap in percentiles when B1 lands). Show
  sub-scores; never just one opaque number.
- Solve replay UI (scrub through phases on the twisty player).
- **Deliverable:** the MVP analysis product. Usable daily by real cubers.

### A4. Cross+1 / XCross planner (1 weekend, needs B2)
- UI over the B2 enumerators: pick cross color(s) → ranked cross / cross+1 /
  xcross candidates; practice mode (plan in inspection, then reveal).
- **Deliverable:** planner feature.

### A5. "What would a pro do" diff (1–2 weekends, needs B2; upgraded by B3)
- At each decision point (post-cross, after each pair): compare user continuation
  vs best candidate; v1 ranking = search heuristics (movecount, rotations), v2 =
  learned ranking model. Show *why* (interpretable features → plain-language
  reasons). Branch playback in the replay UI.
- **Deliverable:** the differentiating feature.

## Track B — Data + model

### B1. Pro reconstruction corpus (1 weekend, parallel with A1–A2)
- Scraper/parser for reco.nz (rate-limited, credited; check ToS / ask about an
  export — community project, be a good citizen). Normalize notation.
- **Verify every solve against the engine** (parse → apply → solved?); drop or
  fix failures. Segment with the A2 segmenter. CFOP-filter.
- EDA: per-phase movecount/rotation distributions, pair-order stats — these
  become the A3 scoring baselines.
- **Deliverable:** clean, verified, segmented corpus + stats. (Resume: real data
  engineering — scraped, parsed, verified, not a Kaggle download.)

### B2. Search baselines / candidate enumerators (1 weekend)
- Optimal cross solver (IDA* + pruning tables), cross+1, depth-limited xcross;
  F2L insertion enumerator per pair. Web Worker/WASM budget: interactive speeds.
- Powers A4 and A5-v1, and generates training candidates for B3.
- **Deliverable:** solver package with perf benchmarks.

### B3. Ranking model v1 (1–2 weekends)
- Training data: at each decision point in a pro solve, pro's actual choice =
  positive; enumerated alternatives = negatives. Learn to rank.
- v1 = features + small MLP (movecount, rotations, regrip proxies, pair-order
  context) — interpretable, data-efficient. v2 = token encoder if v1 plateaus.
- Eval: top-1/top-3 agreement with held-out pro choices; report vs a
  movecount-only baseline (the model must beat "fewest moves wins" to matter).
- Export ONNX → in-browser inference; upgrade A5 and planner ranking.
- **Deliverable:** the trained model + eval writeup. This is the resume headline.

### B4. Stretch (unordered, only after A5+B3 ship)
- Generative model: small transformer, pretrain on synthetic method-consistent
  solves, fine-tune on corpus. Full-solve "pro line" generation.
- Per-solver style conditioning (data-thin: ~50–300 recons/solver — verify first).
- Lookahead/pause coaching (predict where pauses happen from solve features).
- Algorithm trainer (smart-cube-timed recognition/execution split).
- iOS via native wrapper.

## Dependencies

```
A0 ──► A1 ──► A2 ──► A3 (heuristic bands) ──► A3+ (percentiles, needs B1)
 │             │
 │             └────► B1 ──► B3 ──► A5-v2 / planner ranking
 └────────────► B2 ──► A4, A5-v1
```

**MVP = A0–A3 + B1** (~6–8 part-time weekends): smart cube analysis app with
pro-percentile scoring. Ship it to the cubing community, collect feedback, then
build A4/A5/B3 with real users waiting.

## Sequencing vs everything else

- pokemon-classifier **Phase 2 first** (one weekend — unlocks the locked KB
  bullets and closes that project's biggest gap). Then start A0 here.
- Ship-early rule: A3 goes public before any model work beyond B1. Real users
  beat model polish for both learning and resume value.

## Risks

| Risk | Mitigation |
|---|---|
| BLE protocol pain eats weeks | Existing libs first; one cube model only; manual input mode keeps everything else unblocked |
| Corpus smaller/dirtier than hoped | Engine-verification filters junk; percentile scoring works from ~1–2K solves; ranking model is data-efficient by design |
| Composite score feels arbitrary | Percentiles vs pro corpus, visible sub-scores |
| Scope creep (it's 3 projects in a trenchcoat) | Scope guard above; MVP line; algorithm trainer stays parked |
| Ranking model ≈ movecount baseline | Report honestly; the analysis of *when* pros deviate from min-movecount is itself the interesting writeup |
