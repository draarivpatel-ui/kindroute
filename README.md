# KindRoute Engine

Pure algorithmic core for the KindRoute mutual-aid volunteer matching and
capacitated neighborhood routing demo. Zero npm dependencies, zero backend,
pure ES modules. Every algorithm is deterministic and unit tested.

## Run the tests

```bash
npm test
```

This runs `node --test tests/*.test.mjs` (25 tests, no install step needed).

## Modules

| Module | Purpose |
| --- | --- |
| `src/hungarian.js` | Exact O(n^3) Hungarian matcher with a six-phase visual step trace |
| `src/routing.js` | Clarke-Wright savings merging, 2-opt polish, FCFS baseline and side-by-side metrics |
| `src/crypto-card.js` | AES-256-GCM encrypted, shareable route cards using Web Crypto only |
| `src/scenarios.js` | Three seeded synthetic neighborhood presets and a deterministic weather surge injector |
| `src/dispatch.js` | Cost-matrix construction, constrained matching and the end-to-end dispatch pipeline |
| `src/index.js` | Barrel exporting all public APIs |

## Visual stepper data

`hungarian(matrix)` returns `steps[]` with these types: `row-reduction`,
`col-reduction`, `star-zeros`, `cover-cols`, `augment-path` and
`final-assignment`. Each step carries a title, detail and the structured data
needed to animate that phase.

`optimizeRoutes(assignments)` returns:

- `savingsSteps[]`: one entry per accepted Clarke-Wright merge, with the
  saving value and the before/after stop clusters.
- `swapTrace[]`: accepted 2-opt swaps only, each with `beforeDist`,
  `afterDist`, `delta`, `edgeA`, `edgeB` and the resulting stop order.
  Every accepted swap is strictly distance-improving.
- `evaluations[]`: every candidate edge pair 2-opt considered, including
  rejected ones, so the stepper always has animation data even when a route
  is already optimal.

## Encrypted shareable cards

```js
import { encryptCard, decryptCard, parseShareFragment } from './src/crypto-card.js';

const sealed = await encryptCard({ volunteerId: 'v1', stops: [] });
const url = `https://your.app/${sealed.fragment}`;
const card = await decryptCard(...Object.values(parseShareFragment(sealed.fragment)));
```

A fresh 256-bit key and a random 96-bit IV are generated per card. The URL
fragment carries both ciphertext and key, so no server database and no
plaintext PII are needed.

## Verified benchmark snapshot

Deterministic metrics from `runDispatch`, compared against a naive
first-come-first-served baseline. Gini `0.00` means perfectly even workload.

| Scenario | Distance saved | Gini (optimized / FCFS) | Median response min (optimized / FCFS) |
| --- | ---: | ---: | ---: |
| Oakwood Mutual Aid Groceries | 49.35% | 0.393 / 0.650 | 1.451 / 2.757 |
| Student After-School Tutoring Pod | 21.342% | 0.313 / 0.563 | 1.847 / 5.634 |
| Winter Freeze Senior Check-In | 33.196% | 0.556 / 0.756 | 1.284 / 2.354 |
| Winter Freeze + weather surge (seed 4242, 5 requests) | 40.978% | 0.444 / 0.607 | 1.328 / 3.401 |

These are synthetic scenario results, not real-world pilot claims. One grid
unit represents 50 meters; speeds are 1.6 (walk), 4.8 (bike) and 12 (car)
units per minute.

## Determinism

All randomness comes from a seeded Mulberry32 PRNG. There are no
`Math.random()` calls and no wall-clock reads anywhere in the engine. The full
dispatch pipeline produces byte-identical results across repeated runs, which
the test suite verifies.
