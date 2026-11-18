/**
 * Deterministic unit tests for the KindRoute engine.
 * Run with: node --test tests/*.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { hungarian, validateMatrix, expandSlots } from '../src/hungarian.js';
import {
  optimizeRoutes, baselineDispatch, twoOpt, compareDispatch, gini, median, distance, TRAVEL_MODES,
} from '../src/routing.js';
import {
  generateKey, encryptCard, decryptCard, buildShareUrl, parseShareFragment,
} from '../src/crypto-card.js';
import {
  SCENARIOS, SKILLS, mulberry32, injectSurge, cloneScenario, listScenarioIds,
} from '../src/scenarios.js';
import {
  buildCostMatrix, matchRequests, toAssignments, runDispatch,
} from '../src/dispatch.js';

// ---------------------------------------------------------------------------
// Deterministic helper PRNG for tests (no Math.random anywhere)
// ---------------------------------------------------------------------------
function seeded(seed) {
  return mulberry32(seed);
}

function bruteForceCost(matrix) {
  const n = matrix.length;
  const m = matrix[0].length;
  if (n === 0 || m === 0) return 0;
  if (n > m) {
    const t = Array.from({ length: m }, () => new Array(n));
    for (let i = 0; i < n; i += 1) for (let j = 0; j < m; j += 1) t[j][i] = matrix[i][j];
    return bruteForceCost(t);
  }
  const cols = Array.from({ length: m }, (_, i) => i);
  let best = Number.POSITIVE_INFINITY;
  const suffix = new Array(n + 1).fill(0);
  function recurse(row, used) {
    if (row === n) {
      let cost = 0;
      for (let r = 0; r < n; r += 1) cost += matrix[r][chosen[r]];
      if (cost < best) best = cost;
      return;
    }
    if (costLowerBound(row, used) >= best) return;
    for (let k = 0; k < cols.length; k += 1) {
      const c = cols[k];
      if (used.has(c)) continue;
      used.add(c);
      chosen[row] = c;
      recurse(row + 1, used);
      used.delete(c);
    }
  }
  const chosen = new Array(n);
  function costLowerBound(row, used) {
    let lb = 0;
    for (let r = row; r < n; r += 1) {
      let min = Number.POSITIVE_INFINITY;
      for (let c = 0; c < m; c += 1) if (!used.has(c)) min = Math.min(min, matrix[r][c]);
      lb += min;
    }
    return lb;
  }
  recurse(0, new Set());
  return best;
}

// ---------------------------------------------------------------------------
// Hungarian exact optimality (20+ randomized matrices, <= 7x7)
// ---------------------------------------------------------------------------
test('Hungarian matches brute-force optimum on 24 randomized matrices', () => {
  const rng = seeded(0xc0ffee);
  for (let t = 0; t < 24; t += 1) {
    const n = 1 + Math.floor(rng() * 7);
    const m = 1 + Math.floor(rng() * 7);
    const matrix = Array.from({ length: n }, () =>
      Array.from({ length: m }, () => Math.floor(rng() * 90)));
    const solved = hungarian(matrix);
    const expected = bruteForceCost(matrix);
    assert.equal(solved.totalCost, expected, `matrix ${t} (${n}x${m}) cost mismatch`);
    assert.equal(solved.matchedCount, Math.min(n, m), `matrix ${t} should match min dimension`);
    assert.equal(solved.assignment.length, n);
    const usedCols = new Set();
    let recomputed = 0;
    for (let r = 0; r < n; r += 1) {
      const c = solved.assignment[r];
      if (c >= 0) {
        assert.ok(c >= 0 && c < m);
        assert.ok(!usedCols.has(c), `column ${c} assigned twice`);
        usedCols.add(c);
        recomputed += matrix[r][c];
      }
    }
    assert.equal(recomputed, expected);
  }
});

test('Hungarian handles square, tall and wide matrices', () => {
  assert.equal(hungarian([[1, 2], [3, 4]]).totalCost, 5);
  assert.equal(hungarian([[1, 2, 3], [4, 5, 6]]).totalCost, 6);
  assert.equal(hungarian([[1, 2], [3, 4], [5, 6]]).totalCost, 5);
});

test('Hungarian handles empty matrices and rejects malformed input', () => {
  assert.deepEqual(hungarian([]).assignment, []);
  assert.deepEqual(hungarian([[], []]).assignment, [-1, -1]);
  assert.throws(() => validateMatrix([[1, 2], [3]]), TypeError);
  assert.throws(() => validateMatrix([[1, Number.NaN]]), TypeError);
  assert.throws(() => validateMatrix('not a matrix'), TypeError);
});

test('Hungarian records all six step types with valid indices', () => {
  const matrix = [[4, 1, 3], [2, 0, 5], [3, 2, 2]];
  const result = hungarian(matrix);
  const types = new Set(result.steps.map((s) => s.type));
  for (const type of ['row-reduction', 'col-reduction', 'star-zeros', 'cover-cols', 'augment-path', 'final-assignment']) {
    assert.ok(types.has(type), `missing step type ${type}`);
  }
  assert.ok(result.steps.every((s, i) => s.index === i));
  const final = result.steps.at(-1);
  assert.equal(final.pairs.length, result.matchedCount);
  for (const pair of final.pairs) {
    assert.ok(pair.row >= 0 && pair.row < matrix.length);
    assert.ok(pair.col >= 0 && pair.col < matrix[0].length);
  }
  for (const step of result.steps.filter((s) => s.type === 'augment-path')) {
    for (const item of step.path) {
      assert.ok(Number.isInteger(item.row) && Number.isInteger(item.col));
    }
  }
});

test('expandSlots expands capacity into individual slots without losing ids', () => {
  const slots = expandSlots([
    { id: 'a', capacity: 3 },
    { id: 'b', capacity: 1 },
    { id: 'c', capacity: 0 },
  ]);
  assert.equal(slots.length, 4);
  assert.deepEqual(slots.map((s) => s.volunteerId), ['a', 'a', 'a', 'b']);
  assert.deepEqual(slots.map((s) => s.slotIndex), [0, 1, 2, 0]);
});

// ---------------------------------------------------------------------------
// Scenario determinism, PRNG, surge
// ---------------------------------------------------------------------------
test('scenarios are realistic, honest synthetic presets with required fields', () => {
  assert.deepEqual(listScenarioIds(), ['oakwood', 'tutoring', 'winter']);
  for (const id of listScenarioIds()) {
    const s = SCENARIOS[id];
    assert.ok(s.id && s.name && s.description);
    assert.ok(s.volunteers.length >= 3);
    assert.ok(s.requests.length >= 5);
    assert.ok(s.grid && s.grid.columns > 0 && s.grid.rows > 0);
    for (const v of s.volunteers) {
      assert.ok(['walk', 'bike', 'car'].includes(v.mode));
      assert.ok(v.capacity > 0 && Number.isFinite(v.home.x) && Number.isFinite(v.home.y));
    }
    for (const r of s.requests) {
      assert.ok(Number.isFinite(r.location.x) && Number.isFinite(r.location.y));
      assert.ok(r.urgency >= 1 && r.urgency <= 5);
      assert.ok(r.deadline > 0 && r.windowMinutes > 0);
    }
  }
});

test('Mulberry32 is deterministic and produces values in [0,1)', () => {
  const a = mulberry32(12345);
  const b = mulberry32(12345);
  for (let i = 0; i < 1000; i += 1) {
    const value = a();
    assert.equal(value, b());
    assert.ok(value >= 0 && value < 1);
  }
});

test('injectSurge is deterministic and adds urgent requests without mutating input', () => {
  const base = SCENARIOS.oakwood;
  const before = JSON.stringify(base);
  const s1 = injectSurge(base, 777, 4);
  const s2 = injectSurge(base, 777, 4);
  assert.deepEqual(s1, s2);
  assert.equal(JSON.stringify(base), before);
  assert.equal(s1.requests.length, base.requests.length + 4);
  assert.equal(s1.surge.count, 4);
  for (const r of s1.requests.slice(base.requests.length)) assert.equal(r.urgency, 5);
  const different = injectSurge(base, 778, 4);
  assert.notDeepEqual(s1.requests.slice(-4), different.requests.slice(-4));
});

test('cloneScenario deep clones without shared references', () => {
  const copy = cloneScenario(SCENARIOS.winter);
  copy.volunteers[0].home.x = -999;
  assert.notEqual(SCENARIOS.winter.volunteers[0].home.x, -999);
});

// ---------------------------------------------------------------------------
// Cost matrix, constraints and matching invariants
// ---------------------------------------------------------------------------
test('cost matrix penalizes urgency, skill mismatch and time-window violation', () => {
  const volunteers = [{ id: 'v1', capacity: 1, mode: 'walk', skills: [], home: { x: 0, y: 0 } }];
  const requests = [
    { id: 'r1', location: { x: 1, y: 0 }, urgency: 5, load: 1, deadline: 480, windowMinutes: 120 },
    { id: 'r2', location: { x: 1, y: 0 }, urgency: 1, load: 1, deadline: 480, windowMinutes: 120 },
  ];
  const { matrix } = buildCostMatrix(volunteers, requests, { strictSkills: false });
  assert.ok(matrix[0][0] < matrix[0][1]);

  const skillRequests = [{ id: 's1', location: { x: 1, y: 0 }, urgency: 3, load: 1, skillRequired: SKILLS.TUTORING, windowMinutes: 120 }];
  const without = buildCostMatrix(volunteers, skillRequests).matrix[0][0];
  const withSkill = buildCostMatrix([{ ...volunteers[0], skills: [SKILLS.TUTORING] }], skillRequests).matrix[0][0];
  assert.ok(without > withSkill);
});

test('matching never overloads volunteers and serves all feasible urgent requests', () => {
  for (const id of listScenarioIds()) {
    const scenario = SCENARIOS[id];
    const result = runDispatch(scenario);
    const volunteerCapacity = new Map(scenario.volunteers.map((v) => [v.id, v.capacity]));
    const assignedCount = new Map();
    for (const m of result.matched.matches) {
      assignedCount.set(m.volunteerId, (assignedCount.get(m.volunteerId) ?? 0) + 1);
    }
    for (const [vid, count] of assignedCount) {
      assert.ok(count <= volunteerCapacity.get(vid), `${id}: ${vid} overloaded (${count}/${volunteerCapacity.get(vid)})`);
    }
    const feasibleUrgent = scenario.requests.filter((r) => {
      if (r.urgency !== 5) return false;
      return r.skillRequired
        ? scenario.volunteers.some((v) => v.skills.includes(r.skillRequired))
        : true;
    });
    const servedIds = new Set(result.matched.matches.map((m) => m.requestId));
    for (const request of feasibleUrgent) {
      assert.ok(servedIds.has(request.id), `${id}: feasible urgent request ${request.id} was left unserved`);
    }
  }
});

test('matching respects skill requirements under strict mode', () => {
  for (const id of listScenarioIds()) {
    const scenario = SCENARIOS[id];
    const result = matchRequests(scenario.volunteers, scenario.requests, { strictSkills: true });
    for (const match of result.matches) {
      if (!match.request.skillRequired) continue;
      assert.ok(match.volunteer.skills.includes(match.request.skillRequired));
    }
  }
});

// ---------------------------------------------------------------------------
// Routing: 2-Opt, savings, metrics
// ---------------------------------------------------------------------------
test('twoOpt never increases distance and records valid swap indices', () => {
  const rng = seeded(0x2bef);
  const points = Array.from({ length: 8 }, (_, i) => ({
    id: `p${i}`, x: rng() * 100, y: rng() * 100, load: 1,
  }));
  const depot = { x: 50, y: 50 };
  const order = points.map((_, i) => i);
  const result = twoOpt(order, points, depot);
  assert.ok(result.distance <= closedDistanceForTest(order, points, depot) + 1e-9);
  assert.equal(result.order.length, order.length);
  assert.deepEqual(new Set(result.order), new Set(order));
  for (const swap of result.swapTrace) {
    assert.ok(swap.afterDist <= swap.beforeDist + 1e-6);
    assert.ok(swap.edgeA[0] >= 0 && swap.edgeA[1] < order.length);
    assert.ok(swap.edgeB[0] >= 0 && swap.edgeB[1] < order.length);
    assert.ok(Number.isFinite(swap.beforeDist) && Number.isFinite(swap.afterDist));
  }
});

function closedDistanceForTest(order, points, depot) {
  if (!order.length) return 0;
  let total = distance(depot, points[order[0]]);
  for (let i = 0; i < order.length - 1; i += 1) total += distance(points[order[i]], points[order[i + 1]]);
  return total + distance(points[order[order.length - 1]], depot);
}

test('optimizeRoutes produces feasible routes for every scenario and surge', () => {
  for (const id of listScenarioIds()) {
    const scenario = SCENARIOS[id];
    const variants = [scenario, injectSurge(scenario, 4242, 5)];
    for (const variant of variants) {
      const result = runDispatch(variant);
      assert.ok(result.optimized.routes.length > 0, `${id}: no routes produced`);
      assert.ok(result.optimized.totalDistance > 0);
      for (const route of result.optimized.routes) {
        assert.equal(route.feasible, true);
        const volunteer = variant.volunteers.find((v) => v.id === route.volunteerId);
        assert.ok(volunteer, `${id}: unknown volunteer on route`);
        assert.ok(route.load <= TRAVEL_MODES[volunteer.mode].maxLoad + 1e-9, `${id}: route load exceeds mode capacity`);
        assert.ok(route.requestIds.length > 0);
      }
    }
  }
});

test('metrics report non-negative distance savings and improved Gini vs FCFS', () => {
  for (const id of listScenarioIds()) {
    for (const variant of [SCENARIOS[id], injectSurge(SCENARIOS[id], 31337, 6)]) {
      const { metrics } = runDispatch(variant);
      assert.ok(metrics.totalDistance.savedPercent >= 0, `${id}: negative savings`);
      assert.ok(metrics.totalDistance.savedPercent <= 100, `${id}: savings above 100`);
      assert.ok(metrics.gini.optimized >= 0 && metrics.gini.optimized <= 1);
      assert.ok(metrics.gini.baseline >= 0 && metrics.gini.baseline <= 1);
      assert.ok(metrics.gini.improvement >= 0, `${id}: Gini did not improve for ${variant.id}`);
      assert.ok(metrics.medianResponseLatencyMinutes.optimized >= 0);
      assert.ok(metrics.unfulfilledRequests.optimized >= 0);
    }
  }
});

test('gini and median behave correctly on known vectors', () => {
  assert.equal(gini([1, 1, 1, 1]), 0);
  assert.ok(gini([0, 0, 0, 10]) > 0.7);
  assert.equal(gini([]), 0);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), 0);
});

test('2-opt stepper records candidate evaluations and monotonic accepted swaps', () => {
  const rng = seeded(0x5eed);
  const points = Array.from({ length: 9 }, (_, i) => ({
    id: `s${i}`, x: rng() * 80, y: rng() * 80, load: 1,
  }));
  const depot = { x: 40, y: 40 };
  const order = points.map((_, i) => i);
  const result = twoOpt(order, points, depot);
  assert.ok(result.evaluations.length > 0, 'expected 2-opt candidate evaluations for the stepper');
  for (const evaluation of result.evaluations) {
    assert.ok(evaluation.edgeA[0] >= 0 && evaluation.edgeA[1] >= evaluation.edgeA[0] + 2);
    assert.deepEqual(evaluation.edgeB, evaluation.edgeA);
    assert.ok(Number.isFinite(evaluation.beforeDist) && Number.isFinite(evaluation.afterDist));
    assert.equal(typeof evaluation.accepted, 'boolean');
  }
  for (const swap of result.swapTrace) {
    assert.ok(swap.afterDist <= swap.beforeDist + 1e-6, 'accepted swap increased distance');
    assert.ok(swap.edgeA[0] >= 0 && swap.edgeA[1] >= swap.edgeA[0] + 2);
  }
  assert.ok(result.distance <= closedDistanceForTest(order, points, depot) + 1e-9);
});

test('Clarke-Wright stepper records valid merges for every scenario', () => {
  for (const id of listScenarioIds()) {
    const { optimized } = runDispatch(SCENARIOS[id]);
    assert.ok(optimized.savingsSteps.length > 0, `${id}: no savings merges recorded`);
    for (const merge of optimized.savingsSteps) {
      assert.ok(merge.saving > 0);
      assert.ok(merge.after.length > merge.before[0].length);
      assert.ok(Number.isInteger(merge.index) && merge.index >= 0);
    }
    for (const swap of optimized.swapTrace) {
      assert.ok(swap.afterDist <= swap.beforeDist + 1e-6, `${id}: accepted swap increased distance`);
    }
  }
});

// ---------------------------------------------------------------------------
// Crypto card codec
// ---------------------------------------------------------------------------
test('AES-GCM card round-trips with fresh random keys and IVs', async () => {
  const card = {
    volunteerId: 'v-oak-1', name: 'Maya', mode: 'car',
    stops: [{ id: 'r-oak-1', x: 3.12, y: 2.04 }],
    note: 'Unicode check: cafe naıve',
  };
  const a = await encryptCard(card);
  const b = await encryptCard(card);
  assert.notEqual(a.ciphertext, b.ciphertext, 'IV must be random');
  assert.notEqual(a.key, b.key, 'key must be fresh');
  assert.deepEqual(await decryptCard(a.ciphertext, a.key), card);
  assert.deepEqual(await decryptCard(b.ciphertext, b.key), card);
});

test('wrong key and bit-flipped ciphertext fail authentication cleanly', async () => {
  const card = { volunteerId: 'v1', secret: 'sensitive value' };
  const encrypted = await encryptCard(card);
  const wrongKey = await generateKey();
  await assert.rejects(() => decryptCard(encrypted.ciphertext, wrongKey), /Authentication failed/);

  const bytes = Buffer.from(encrypted.ciphertext.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const flipped = Uint8Array.from(bytes);
  flipped[flipped.length - 1] ^= 0x01;
  const tampered = Buffer.from(flipped).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await assert.rejects(() => decryptCard(tampered, encrypted.key), /Authentication failed/);
});

test('share URL fragment round-trips and stays within a URL length budget', async () => {
  const card = {
    volunteerId: 'v-wnt-1', name: 'Faye', mode: 'car',
    stops: Array.from({ length: 8 }, (_, i) => ({ id: `r-${i}`, x: i * 1.5, y: i * 0.7, load: 2 })),
  };
  const encrypted = await encryptCard(card);
  const url = buildShareUrl('https://kindroute.example/', encrypted);
  assert.ok(url.startsWith('https://kindroute.example/#card='));
  const fragment = url.slice(url.indexOf('#'));
  assert.deepEqual(parseShareFragment(fragment), { ciphertext: encrypted.ciphertext, key: encrypted.key });
  assert.ok(url.length < 2048, `share URL too long: ${url.length}`);
  assert.deepEqual(await decryptCard(...Object.values(parseShareFragment(fragment))), card);
});

test('codec rejects malformed inputs', async () => {
  await assert.rejects(() => encryptCard('not an object'), TypeError);
  await assert.rejects(() => decryptCard('short', 'key'), TypeError);
  assert.throws(() => parseShareFragment('#card=only'), TypeError);
  await assert.rejects(() => decryptCard('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'bad'), TypeError);
});

// ---------------------------------------------------------------------------
// Determinism of the full pipeline
// ---------------------------------------------------------------------------
test('full dispatch pipeline is deterministic across repeated runs', () => {
  const scenario = injectSurge(SCENARIOS.winter, 90210, 5);
  const a = runDispatch(scenario);
  const b = runDispatch(scenario);
  assert.deepEqual(a.matched.matches, b.matched.matches);
  assert.deepEqual(a.optimized.routes, b.optimized.routes);
  assert.deepEqual(a.metrics, b.metrics);
});

test('all module APIs are exported from the barrel', async () => {
  const barrel = await import('../src/index.js');
  for (const name of ['hungarian', 'routing', 'cryptoCard', 'scenarios', 'dispatch', 'runDispatch', 'injectSurge']) {
    assert.ok(name in barrel, `missing export ${name}`);
  }
});

// ---------------------------------------------------------------------------
// Deterministic benchmark snapshot (honest side-by-side metrics)
// ---------------------------------------------------------------------------
test('benchmark snapshot: distance saved, Gini fairness and response latency vs FCFS', () => {
  const expected = {
    oakwood: { saved: 49.35, giniOptimized: 0.393, giniBaseline: 0.65, latencyOptimized: 1.451, latencyBaseline: 2.757 },
    tutoring: { saved: 21.342, giniOptimized: 0.313, giniBaseline: 0.563, latencyOptimized: 1.847, latencyBaseline: 5.634 },
    winter: { saved: 33.196, giniOptimized: 0.556, giniBaseline: 0.756, latencyOptimized: 1.284, latencyBaseline: 2.354 },
  };
  for (const [id, values] of Object.entries(expected)) {
    const { metrics } = runDispatch(SCENARIOS[id]);
    assert.equal(metrics.totalDistance.savedPercent, values.saved, `${id} distance savings`);
    assert.equal(metrics.gini.optimized, values.giniOptimized, `${id} optimized Gini`);
    assert.equal(metrics.gini.baseline, values.giniBaseline, `${id} FCFS Gini`);
    assert.equal(metrics.medianResponseLatencyMinutes.optimized, values.latencyOptimized, `${id} optimized latency`);
    assert.equal(metrics.medianResponseLatencyMinutes.baseline, values.latencyBaseline, `${id} FCFS latency`);
  }
  const surge = runDispatch(injectSurge(SCENARIOS.winter, 4242, 5)).metrics;
  assert.equal(surge.totalDistance.savedPercent, 40.978);
  assert.equal(surge.gini.optimized, 0.444);
  assert.equal(surge.gini.baseline, 0.607);
});
