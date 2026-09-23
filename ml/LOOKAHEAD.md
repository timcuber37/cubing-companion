# Deeper planning and the next learned model

Evaluate a decision partly by the position it creates. A longer first pair or cross can be
preferable if it makes the following pairs easier. This change implements a working search
baseline for that objective. It does **not** train new weights or establish faster human execution.

## Implemented behavior

| Goal | Candidates | Ranking |
|---|---|---|
| Cross | Existing optimal cross candidates | Length, then the existing model or comfort |
| X-cross | Joint cross + named pair, including +1 alternatives | Length, then comfort |
| Cross + 1 | Cross-first insertions and joint solutions | Total turns through at least one solved pair |
| Cross + 2 | Cross-first, x-cross continuations, and joint two-pair goals | Total turns through at least two solved pairs |
| Next pair | Multiple optimal and +1 insertions, followed by further insertions | Total through the same horizon; model preference breaks ties in the live panel |

Cross + 2 describes an endpoint. The joint search can find an XX-cross without passing through
a retained cross candidate. Incidentally solved pairs count immediately. Each insertion leaves
the cross and previously built pairs solved at its endpoint; they may move during the insertion.

The browser plans two additional pairs, including the current pair. The library supports one
to four and reduces the horizon when fewer remain. It displays executable steps, with setup
rotations included in playback but excluded from turn counts. Solve review shows search advice
separately from the imitation model. Percentages still describe first-pair model preference,
not confidence that a whole plan is best. B3's feature schema and trained weights are unchanged.

## Search design and limits

Search runs over pair insertions. Apply each candidate to the full cube, retain distinct resulting
positions, then expand again. A beam uses turns so far plus an admissible pair-distance bound;
solved-pair count and accessible remaining pieces break ties. Each first-pair choice gets its
own beam and equal node budget. Per-depth caps reserve space for +1 alternatives.

Defaults: beam width four, one extra move per insertion, 50,000 nodes per insertion search and
1,600,000 nodes across first-pair options. Inspection retains up to eight opening seeds, allows
300,000 continuation nodes per seed, and searches the six joint two-slot goals with 50,000 nodes
each. Cross and x-cross seed searches also have caps. These are experimental operating budgets.

The insertion solver uses the maximum of exact cross and required-pair distances for pruning.
An individual insertion's optimum is known when all smaller depths were exhausted. Candidate
caps, beam pruning and unsearched roots prevent an overall optimality claim. Missing continuations
are `null`, never zero turns. Node budgets are reproducible but are not wall-clock guarantees
across devices. The browser worker yields between colours to abandon superseded sweeps.

## Regression example

Start with `B U2 R2 D L' R2 L' D2 R2`, then build the yellow cross with `L D F L' D2 L`.
The search finds BL in five moves followed by BR in four: **nine total**. Taking the available
four-move BR insertion leads to a six-move FR continuation: **ten total**. Tests replay these
sequences and verify the solved slots. This demonstrates lookahead, not aggregate quality or
human execution speed.

## Proposed policy and value models

Keep the cube engine as the transition model: move effects are known exactly. Learn human
difficulty and the value of the resulting position. A policy scorer can prioritize insertions;
a value scorer can estimate remaining F2L cost at the edge of the search.

Start with a small model over transition features: immediate turns, trigger structure, grip
changes, exposed/buried pieces, cheapest next insertion, alternative next pairs, and deeper
rollout costs. Include reached horizon and truncation. Visibility and tracking features should
be labelled geometric estimates, not observed gaze or measured recognition time.

Use a new versioned feature schema and export. Never append columns to `PAIR_FEATURES` while
reusing existing weights. Keep feature extraction shared between dataset construction and browser
inference. A proposed objective combines execution cost so far, recognition/transition cost and
estimated remaining F2L cost. Fit its scale on held-out data; raw logits and turn counts have
unrelated units. Initially the existing policy can order expansion while verified costs rank
completed plans.

## Dataset plan

Extend the builder with `(before state, sequence, after state, grip, continuation, budget,
horizon, source solve)` records. Include longer crosses, x-crosses, different executions of the
same pair, and alternative pair orders.

Keep human and search supervision distinct. A reconstruction labels what a person did; it does
not prove every unchosen action is worse or was considered. Bounded search supplies verified
upper bounds for alternative continuations, not measured human times or exact remaining distances.
Replan each branch from its actual state. Applying a human's recorded later moves to a changed
state does not make a valid rollout. Include missed human actions when training imitation and
record candidate recall. Never label interrupted rollouts as cheap completions. Recognition and
pause targets require reliable timing; static reconstructions do not provide pause observations.

The current `pairDecisions` extractor remains unchanged to preserve B3's training/inference
contract. It rejects some x-cross and simultaneous-insertion reconstructions. A versioned
extension should group actual transitions, skip solved slots and label multi-pair insertions
without inventing decisions. Solve review needs the matching extension before those cases get
full learned analysis.

## Evaluation and rollout

Compare immediate move count, B3 policy, bounded lookahead and search with the new value model
under equal candidate/node budgets. Hold out by solver. Keep all branches and symmetry variants
from one solve in one split, deduplicate equivalent positions across splits where possible, and
use multiple grouped splits.

Measure validity, preservation, coverage of every first-pair choice, x-cross/XX-cross recall,
turns through cross + 1/cross + 2/full F2L, regret against larger offline searches, human choice
accuracy and calibration, execution/pauses where timing exists, and median/tail browser latency
and memory. Report proven results, best-found plans and predictions separately.

Adopt a value model only if it improves continuation quality or achieves comparable quality with
less search. Higher first-pair imitation accuracy alone does not establish better lookahead.
