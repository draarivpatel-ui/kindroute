/**
 * Wave 1 revamp coverage: map bounds correctness, deadline audit, Hungarian
 * trace matrices, UI hierarchy hygiene (no eyebrows, no taglines, no smooth
 * scrolling), the print route sheet cascade, and the tamper-proof contract.
 * Run with: node --test tests/*.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { computeBounds } from '../src/map-viz.js';
import { SCENARIOS, injectSurge } from '../src/scenarios.js';
import { runDispatch } from '../src/dispatch.js';
import { countLateArrivals, compareDispatch } from '../src/routing.js';
import { hungarian } from '../src/hungarian.js';
import { encryptCard, decryptCard, generateKey } from '../src/crypto-card.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const HTML = read('index.html');
const CSS = read('styles.css');
const APP = read('src/app.js');
const MAP = read('src/map-viz.js');

// ---------------------------------------------------------------------------
// Map world bounds: requests are grid units, never re-scaled by spacing
// ---------------------------------------------------------------------------
test('computeBounds returns the street extent for an empty point set', () => {
  const bounds = computeBounds({ columns: 9, rows: 8, spacing: 2 }, []);
  assert.equal(bounds.maxX, 16);
  assert.equal(bounds.maxY, 14);
});

test('computeBounds union includes points beyond the street grid without re-scaling', () => {
  const bounds = computeBounds(
    { columns: 9, rows: 8, spacing: 2 },
    [{ x: 3, y: 2 }, { x: 15.98, y: 13.8 }, { x: 20, y: 5 }],
  );
  assert.equal(bounds.maxX, 20);
  assert.equal(bounds.maxY, 14);
});

test('every preset renders inside a bounds box no larger than the street grid plus points', () => {
  for (const id of Object.keys(SCENARIOS)) {
    const s = SCENARIOS[id];
    const points = [...s.requests.map((r) => r.location), ...s.volunteers.map((v) => v.home)];
    const bounds = computeBounds(s.grid, points);
    const streetX = (s.grid.columns - 1) * s.grid.spacing;
    const streetY = (s.grid.rows - 1) * s.grid.spacing;
    const maxPointX = Math.max(...points.map((p) => p.x));
    const maxPointY = Math.max(...points.map((p) => p.y));
    assert.equal(bounds.maxX, Math.max(streetX, maxPointX), `${id} X bounds`);
    assert.equal(bounds.maxY, Math.max(streetY, maxPointY), `${id} Y bounds`);
    // The old bug doubled the scale: bounds must never exceed the street extent
    // times the spacing (i.e. x2 blowup) when points stay on the grid.
    assert.ok(bounds.maxX < streetX * 1.2, `${id} X bounds look double-scaled: ${bounds.maxX}`);
    assert.ok(bounds.maxY < streetY * 1.2, `${id} Y bounds look double-scaled: ${bounds.maxY}`);
  }
});

test('map-viz exports computeBounds and a zoom/pan controller surface', () => {
  assert.equal(typeof computeBounds, 'function');
  for (const fn of ['zoomBy', 'resetView', 'getView', 'setState', 'setBaseline', 'resize', 'start', 'stop']) {
    assert.match(MAP, new RegExp(`\\b${fn}\\b`), `map controller missing ${fn}`);
  }
  assert.match(MAP, /pointerdown/);
  assert.match(MAP, /wheel/);
});

// ---------------------------------------------------------------------------
// Late-arrival deadline audit
// ---------------------------------------------------------------------------
test('countLateArrivals flags stops past deadline with exact lateness', () => {
  const requests = [
    { id: 'r1', deadline: 10 },
    { id: 'r2', deadline: 100 },
  ];
  const routes = [
    {
      volunteerId: 'v1',
      legs: [
        { requestId: 'r1', arrivalMinutes: 12 },
        { requestId: 'r2', arrivalMinutes: 90 },
      ],
    },
  ];
  const audit = countLateArrivals(routes, requests);
  assert.equal(audit.count, 1);
  assert.equal(audit.stops[0].requestId, 'r1');
  assert.equal(audit.stops[0].deadline, 10);
  assert.equal(audit.stops[0].latenessMinutes, 2);
});

test('countLateArrivals returns zero for empty routes and handles unknown ids', () => {
  assert.equal(countLateArrivals([], [{ id: 'r1', deadline: 5 }]).count, 0);
  assert.equal(countLateArrivals([{ volunteerId: 'v', legs: [{ requestId: 'ghost', arrivalMinutes: 9 }] }], []).count, 0);
});

test('metrics expose a lateArrivals audit for every preset and the surge variant', () => {
  for (const id of Object.keys(SCENARIOS)) {
    for (const variant of [SCENARIOS[id], injectSurge(SCENARIOS[id], 4242, 5)]) {
      const { metrics } = runDispatch(variant);
      assert.ok(Number.isFinite(metrics.lateArrivals.optimized), `${id} optimized late count`);
      assert.ok(Number.isFinite(metrics.lateArrivals.baseline), `${id} baseline late count`);
      assert.ok(metrics.lateArrivals.optimized >= 0);
      assert.ok(Array.isArray(metrics.lateArrivals.optimizedStops));
    }
  }
});

test('late-arrival audit agrees with an independent recount from optimized routes', () => {
  for (const id of Object.keys(SCENARIOS)) {
    const result = runDispatch(SCENARIOS[id]);
    const recount = countLateArrivals(result.optimized.routes, SCENARIOS[id].requests);
    assert.equal(result.metrics.lateArrivals.optimized, recount.count, id);
    for (const stop of recount.stops) {
      assert.ok(stop.arrivalMinutes > stop.deadline);
    }
  }
});

test('compareDispatch still exposes every legacy metric alongside lateArrivals', () => {
  const { metrics } = runDispatch(SCENARIOS.oakwood);
  for (const key of ['totalDistance', 'gini', 'medianResponseLatencyMinutes', 'lateArrivals', 'unfulfilledRequests', 'routeCount']) {
    assert.ok(key in metrics, `missing metric ${key}`);
  }
});

// ---------------------------------------------------------------------------
// Hungarian trace: every phase now carries its own matrix and labels
// ---------------------------------------------------------------------------
test('all Hungarian phases carry a matrix so the stepper never falls back to raw costs', () => {
  const matrix = [[4, 1, 3], [2, 0, 5], [3, 2, 2]];
  const result = hungarian(matrix, { rowLabels: ['A', 'B', 'C'], colLabels: ['x', 'y', 'z'] });
  assert.ok(result.steps.length >= 6);
  for (const step of result.steps) {
    assert.ok(Array.isArray(step.matrix), `step ${step.type} missing matrix`);
    assert.equal(step.matrix.length, matrix.length, `step ${step.type} matrix row count`);
    assert.deepEqual(step.rowLabels, ['A', 'B', 'C']);
    assert.deepEqual(step.colLabels, ['x', 'y', 'z']);
  }
  // The row-reduction phase shows reduced rows, not raw costs.
  const rowStep = result.steps[0];
  const rowMins = rowStep.matrix.map((row) => Math.min(...row));
  for (const min of rowMins) assert.equal(min, 0, 'row-reduced matrix must have zero row minima');
});

test('Hungarian trace matrices survive the transpose path with valid labels', () => {
  const matrix = [[1, 2, 3], [4, 5, 6]]; // 2x3, no transpose needed
  const tall = [[1, 2], [3, 4], [5, 6]]; // 3x2, transposed internally
  for (const [label, m] of [['wide', matrix], ['tall', tall]]) {
    const result = hungarian(m, {
      rowLabels: m.map((_, i) => `r${i}`),
      colLabels: m[0].map((_, j) => `c${j}`),
    });
    const dims = new Set(result.steps.map((s) => `${s.matrix.length}x${s.matrix[0].length}`));
    for (const step of result.steps) {
      assert.ok(Array.isArray(step.matrix), `${label} step ${step.type} missing matrix`);
      // Every label list matches its matrix dimension and holds strings.
      assert.equal(step.rowLabels.length, step.matrix.length, `${label} ${step.type} rowLabels`);
      assert.equal(step.colLabels.length, step.matrix[0].length, `${label} ${step.type} colLabels`);
      assert.ok(step.rowLabels.every((l) => typeof l === 'string'));
      assert.ok(step.colLabels.every((l) => typeof l === 'string'));
    }
    // The tall matrix is transposed internally; the work matrix stays 2x3.
    assert.ok(dims.size >= 1, label);
    assert.equal(result.totalCost, label === 'wide' ? 6 : 5, label);
  }
});

test('optimality is unchanged after the trace upgrade (brute-force differential)', () => {
  const matrix = [
    [7, 2, 9, 4], [6, 5, 3, 8], [1, 8, 7, 2], [9, 3, 6, 5],
  ];
  const result = hungarian(matrix);
  // Brute force over all 24 permutations.
  let best = Infinity;
  const perms = (arr) => (arr.length <= 1 ? [arr] : arr.flatMap((x, i) => perms(arr.filter((_, j) => j !== i)).map((p) => [x, ...p])));
  for (const p of perms([0, 1, 2, 3])) {
    best = Math.min(best, p.reduce((sum, c, r) => sum + matrix[r][c], 0));
  }
  assert.equal(result.totalCost, best);
});

// ---------------------------------------------------------------------------
// UI hierarchy: no eyebrows, no taglines, no smooth scrolling, print works
// ---------------------------------------------------------------------------
test('index.html contains zero eyebrow kickers, zero brand tagline, zero map subtitle', () => {
  assert.doesNotMatch(HTML, /class="eyebrow"/);
  assert.doesNotMatch(HTML, /brand-tagline/);
  assert.doesNotMatch(HTML, /map-subtitle/);
  assert.doesNotMatch(CSS, /\.eyebrow\s*\{/);
  // The title stands alone: the brand block has exactly one text element.
  assert.match(HTML, /<strong class="brand-title">KindRoute<\/strong>/);
});

test('html and css never opt into smooth scrolling', () => {
  assert.doesNotMatch(CSS, /scroll-behavior\s*:\s*smooth/i);
  assert.doesNotMatch(HTML, /scroll-behavior/i);
});

test('print route sheet escapes the panel cascade via the visibility pattern', () => {
  const printStart = CSS.indexOf('@media print');
  assert.ok(printStart !== -1, 'no print block');
  const printBlock = CSS.slice(printStart);
  assert.match(printBlock, /body \* \{\s*visibility:\s*hidden/);
  assert.match(printBlock, /#print-sheet-doc,\s*#print-sheet-doc \* \{\s*visibility:\s*visible/);
  assert.match(printBlock, /display:\s*block\s*!important/);
  // The old broken pattern must not return: hiding the parent panel kills the sheet.
  assert.doesNotMatch(printBlock, /\.panel \{ display: none/);
});

test('surge note is dynamic and zoom controls exist', () => {
  assert.match(APP, /function updateSurgeNote/);
  assert.match(APP, /injectSurge\(cloneScenario\(SCENARIOS\[state\.scenarioId\]\), 4242, 5\)/);
  assert.match(APP, /\$\('zoom-in'\)\.addEventListener/);
  assert.match(APP, /\$\('zoom-out'\)\.addEventListener/);
  assert.match(APP, /mapViz\?\.resetView\(\)/);
});

// ---------------------------------------------------------------------------
// Tamper-proof contract: one flipped bit must always be rejected
// ---------------------------------------------------------------------------
test('flipping any single ciphertext bit rejects authentication for 64 probe flips', async () => {
  const card = { schema: 1, name: 'Probe', stops: [{ id: 'r1', etaMinutes: 3 }] };
  const sealed = await encryptCard(card);
  const padded = sealed.ciphertext.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (sealed.ciphertext.length % 4)) % 4);
  const base = Buffer.from(padded, 'base64');
  const step = Math.max(1, Math.floor(base.length / 64));
  let probes = 0;
  for (let i = 0; i < base.length && probes < 64; i += step) {
    const flipped = Uint8Array.from(base);
    flipped[i] ^= 0x01;
    const tampered = Buffer.from(flipped).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await assert.rejects(() => decryptCard(tampered, sealed.key), /Authentication failed/, `flip at byte ${i} did not reject`);
    probes += 1;
  }
  assert.ok(probes >= 32, `expected at least 32 probes, ran ${probes}`);
});

test('tamper test UI is wired: button, result box, bit-flip helper and pass/fail classes', () => {
  assert.match(HTML, /id="tamper-test"/);
  assert.match(HTML, /id="tamper-result"/);
  assert.match(APP, /async function runTamperTest/);
  assert.match(APP, /function flipLastCiphertextBit/);
  assert.match(APP, /is-pass/);
  assert.match(APP, /is-fail/);
  assert.match(APP, /\$\('tamper-test'\)\.addEventListener\('click', runTamperTest\)/);
  assert.match(CSS, /\.tamper-result\.is-pass/);
  assert.match(CSS, /\.tamper-result\.is-fail/);
});

test('control decrypt of the sealed card still succeeds before any tampering', async () => {
  const key = await generateKey();
  const sealed = await encryptCard({ schema: 1, stops: [] }, key);
  const card = await decryptCard(sealed.ciphertext, key);
  assert.deepEqual(card, { schema: 1, stops: [] });
});

// ---------------------------------------------------------------------------
// Metric grid: compute time moved into a note; late arrivals got a tile
// ---------------------------------------------------------------------------
test('metric grid contains the late arrivals tile and the compute note', () => {
  assert.match(HTML, /id="metric-late"/);
  assert.match(HTML, /Late arrivals/);
  assert.match(HTML, /stops past deadline/);
  assert.match(APP, /metrics\.lateArrivals\.optimized/);
});
