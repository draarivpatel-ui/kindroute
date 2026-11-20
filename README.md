# KindRoute

Offline civic-dispatch instrument and pure algorithmic engine for mutual-aid
volunteer matching and capacitated neighborhood routing. Zero npm dependencies,
zero backend, zero network requests at runtime. Every preset, request and
volunteer in the browser demo is a **synthetic neighborhood model**: no real
addresses, no community-organization pilots and no field trials are claimed.

## Run the app

Serve this folder over HTTP so ES modules and the service worker load from a
real origin. Any subpath works, including `/kindroute/`:

```bash
python3 -m http.server 8000 --directory .
# open http://127.0.0.1:8000/
```

The app works without a build step. Once the service worker has cached the
assets, it also works with the network disconnected.

## Run the tests

```bash
npm test
```

This runs `node --test tests/*.test.mjs`: **77 tests, 77 pass, 0 fail, 0
skipped**. The engine, crypto and QR suites contribute 42 tests; the UI,
offline-hygiene, security and video-contract suite contributes 15 more; and the
Wave 1 revamp suite (map bounds, deadline audit, trace matrices, tamper probes,
UI hierarchy and print contract) contributes 20 more.

## Browser features

- **Interactive vector map:** a canvas-rendered street grid with depot squares,
  urgency-coded resident pins, solid colored optimized routes and an optional
  dashed first-come-first-served (FCFS) baseline. Cursor-anchored wheel and
  button zoom plus drag panning read dense clusters, and hover or click on any
  pin or depot inspects stop-by-stop ETAs, distance, skill match and load. The
  world extent is computed from the street grid unioned with every point, so
  routes always fill the canvas.
- **Three synthetic presets:** Oakwood groceries, after-school tutoring and
  winter freeze check-in, plus a deterministic emergency-surge toggle (5 urgent
  requests, seed 4242). The surge note shows the exact savings figure the
  toggle produces for the active preset (52.23% on Oakwood, 40.98% on Winter).
  Add a request or adjust volunteer capacity and the engine re-solves in under
  15 ms in the browser.
- **Baseline comparison card:** distance saved, total km, median arrival
  response, workload Gini, unfulfilled requests, a late-arrival deadline audit
  (stops that arrive past their own deadline, optimized vs FCFS) and measured
  compute time, all computed live from the same dispatch run.
- **Algorithm steppers:** "Under the Hood" steps through the exact six-phase
  Hungarian trace (row reduction, column reduction, star zeros, cover columns,
  augmenting path, final assignment) over a cost-matrix heatmap. Every phase
  now carries its own reduced matrix and full volunteer/request labels, so the
  heatmap always shows the solver's true state. It also steps through every
  accepted 2-opt swap with the exact km shaved per reversal.
- **Encrypted dispatch cards:** click a volunteer to seal a JSON route card
  with AES-256-GCM using a fresh 256-bit key and random 96-bit IV. The inline
  ISO QR SVG encodes a `#card=...&k=...` link. Copy Link, Printable Route Sheet
  and Preview Volunteer Card decrypt the fragment locally into a mobile
  checklist with no account or server. The one-click **Run tamper test** button
  flips the last ciphertext bit and proves GCM rejection inline next to the QR.
  Malformed or tampered fragments show a clean error and never execute markup.

## Modules

| Module | Purpose |
| --- | --- |
| `src/hungarian.js` | Exact O(n^3) Hungarian matcher with a six-phase visual step trace |
| `src/routing.js` | Clarke-Wright savings merging, 2-opt polish, FCFS baseline, deadline audit and metrics |
| `src/crypto-card.js` | AES-256-GCM encrypted shareable cards using Web Crypto only |
| `src/scenarios.js` | Three seeded synthetic neighborhood presets and a deterministic surge injector |
| `src/dispatch.js` | Cost-matrix construction, constrained matching and the end-to-end pipeline |
| `src/qr-svg.js` | Zero-dependency ISO/IEC 18004 QR encoder and crisp SVG renderer |
| `src/map-viz.js` | Offline canvas vector map with zoom, pan, hover and click inspection |
| `src/app.js` | Browser controller, algorithm steppers, tamper proof and encrypted-card flow |
| `src/index.js` | Barrel exporting all public APIs |
| `sw.js` | Scope-limited service worker caching only relative app assets |

## Visual stepper data

`hungarian(matrix)` returns `steps[]` with these types: `row-reduction`,
`col-reduction`, `star-zeros`, `cover-cols`, `augment-path` and
`final-assignment`. Each step carries a title, detail, the structured data
needed to animate that phase, and (as of the Wave 1 revamp) its own snapshot
`matrix` plus `rowLabels`/`colLabels` matching the work orientation, so a UI
never has to fall back to raw costs mid-trace.

`optimizeRoutes(assignments)` returns:

- `savingsSteps[]`: one entry per accepted Clarke-Wright merge, with the saving
  value and the before/after stop clusters.
- `swapTrace[]`: accepted 2-opt swaps only, each with `beforeDist`, `afterDist`,
  `delta`, `edgeA`, `edgeB` and the resulting stop order. Every accepted swap is
  strictly distance-improving.
- `evaluations[]`: every candidate edge pair 2-opt considered, including
  rejected ones, so a stepper always has data even for an already-optimal route.

`compareDispatch(optimized, baseline, context)` returns, among other fields, a
`lateArrivals` audit: `{ optimized, baseline, optimizedStops, baselineStops }`
where each stop records `requestId`, `volunteerId`, `arrivalMinutes`,
`deadline` and `latenessMinutes`. The audit measures the honest failure mode of
dispatch planning: a stop can be served yet still arrive late.

## Encrypted shareable cards

```js
import { encryptCard, decryptCard, parseShareFragment } from './src/crypto-card.js';

const sealed = await encryptCard({ volunteerId: 'v1', stops: [] });
const url = `${location.origin}${location.pathname}${sealed.fragment}`;
const card = await decryptCard(...Object.values(parseShareFragment(sealed.fragment)));
```

A fresh 256-bit key and a random 96-bit IV are generated per card. The URL
fragment carries both ciphertext and key, so no server database and no
plaintext PII are needed. The honest limit: the link is the secret, so share it
through a trusted channel. Tamper detection is a first-class demo: the app's
tamper test flips one bit and shows the clean `Authentication failed` rejection.

## Verified benchmark snapshot

Deterministic metrics from `runDispatch`, compared against a naive FCFS
baseline. Gini `0.00` means perfectly even workload. One grid unit represents
50 meters; speeds are 1.6 (walk), 4.8 (bike) and 12 (car) units per minute.

| Scenario | Distance saved | Gini (optimized / FCFS) | Median response min (optimized / FCFS) |
| --- | ---: | ---: | ---: |
| Oakwood Mutual Aid Groceries | 49.35% | 0.393 / 0.650 | 1.451 / 2.757 |
| Student After-School Tutoring Pod | 21.342% | 0.313 / 0.563 | 1.847 / 5.634 |
| Winter Freeze Senior Check-In | 33.196% | 0.556 / 0.756 | 1.284 / 2.354 |
| Oakwood + weather surge (seed 4242, 5 requests) | 52.228% | 0.337 / 0.417 | 1.292 / 3.279 |
| Winter Freeze + weather surge (seed 4242, 5 requests) | 40.978% | 0.444 / 0.607 | 1.328 / 3.401 |

The headline savings are **49.35%**, **21.34%** and **40.98%** on the grocery,
tutoring and winter-surge presets. These are synthetic scenario results, not
real-world pilot claims. The Oakwood optimized plan leaves 1 of 8 requests
unfulfilled while FCFS leaves 0, so the savings figure compares routed distance
for the requests each plan serves, not "more requests served."

## Determinism

All randomness comes from a seeded Mulberry32 PRNG. There are no
`Math.random()` calls and no wall-clock reads anywhere in the engine. The full
dispatch pipeline produces byte-identical results across repeated runs, which
the test suite verifies.

## Privacy and offline model

The page ships no analytics, no external fonts, no map tiles and no CDN
scripts. The service worker caches only relative assets under the app's own
scope and never contacts another origin. Dispatch cards are encrypted in the
browser, and the decryption key stays in the URL fragment; the app never sends
a request when opening or decrypting a card.

## Demo video choreography

`video/narration.txt` is a 260-word script sized for about 95 to 115 seconds.
`video/steps.json` is a cue list compatible with `make-video.mjs`: it clicks
the baseline toggle, switches presets, steps both algorithm traces, toggles the
surge, adjusts capacity, seals a card and opens the decrypted volunteer view.
Every cue targets an element verified by the UI contract test.

## AI-use disclosure

An AI coding assistant helped implement the algorithms, tests, browser UI and
documentation; the author reviewed every change and re-ran every number.
