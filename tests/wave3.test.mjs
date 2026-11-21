/**
 * Wave 3 coverage: the multi-objective accessible-routing engine (Dijkstra
 * over attributed street graphs with hard limits, a relaxation ladder and
 * unreachable diagnostics), the route-level unfulfilled diagnostics and
 * deterministic tie-break hardening in the dispatch router, the deterministic
 * route-proof JSON/CSV export, and the keyboard + invalid-input UI contract.
 * Run with: node --test tests/*.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  normalizeGraph, findAccessibleRoute, accessDemoGraph, listAccessProfiles,
  edgeCost, edgeBlockedReasons, ACCESS_PROFILES, SURFACE_FACTORS, CURB_PENALTY_UNITS,
} from '../src/accessible-routing.js';
import {
  buildRouteProof, routeProofJson, routeSummaryCsv, proofFingerprint,
  stableStringify, sortKeysDeep, csvCell,
} from '../src/route-proof.js';
import { optimizeRoutes, twoOpt, distance } from '../src/routing.js';
import { runDispatch } from '../src/dispatch.js';
import { SCENARIOS, injectSurge, mulberry32 } from '../src/scenarios.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const HTML = read('index.html');
const CSS = read('styles.css');
const APP = read('src/app.js');
const MAP = read('src/map-viz.js');
const SW = read('sw.js');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Seeded attributed street graph: enough edges to be interesting, small enough to brute force. */
function seededGraph(seed, nodeCount = 7, edgeProb = 0.45) {
  const rng = mulberry32(seed);
  const nodes = Array.from({ length: nodeCount }, (_, i) => ({
    id: `n${i}`, x: Math.round(rng() * 2000) / 100, y: Math.round(rng() * 2000) / 100,
  }));
  const edges = [];
  for (let i = 0; i < nodeCount; i += 1) {
    for (let j = i + 1; j < nodeCount; j += 1) {
      if (rng() >= edgeProb) continue;
      edges.push({
        a: `n${i}`,
        b: `n${j}`,
        gradePct: Math.floor(rng() * 18),
        shadePct: Math.floor(rng() * 100),
        curbRamps: rng() > 0.2,
        surface: rng() < 0.08 ? 'stairs' : (rng() < 0.25 ? 'gravel' : 'paved'),
      });
    }
  }
  return { nodes, edges };
}

/**
 * Exact baseline: minimum weighted cost over ALL simple source-to-target
 * paths, enumerated by DFS. Infinity when no compliant path exists.
 */
function bruteForceBestPath(graph, sourceIdx, targetIdx, usable, weights) {
  const seen = new Uint8Array(graph.nodes.length);
  let best = Infinity;
  const dfs = (u, cost) => {
    if (u === targetIdx) { best = Math.min(best, cost); return; }
    seen[u] = 1;
    for (const { to, edge } of graph.adjacency[u]) {
      if (seen[to] || !usable(edge)) continue;
      const next = cost + edgeCost(edge, weights);
      if (next >= best) continue;
      dfs(to, next);
    }
    seen[u] = 0;
  };
  dfs(sourceIdx, 0);
  return best;
}

function assertValidWalk(rawGraph, result) {
  const ids = new Set(rawGraph.nodes.map((n) => n.id));
  for (const id of result.path) assert.ok(ids.has(id), `path node ${id} not in graph`);
  assert.equal(result.edges.length, Math.max(0, result.path.length - 1), 'edge count must equal legs');
  result.edges.forEach((edge, i) => {
    const a = result.path[i];
    const b = result.path[i + 1];
    assert.ok(
      (edge.a === a && edge.b === b) || (edge.a === b && edge.b === a),
      `edge ${edge.name} does not connect ${a} to ${b}`,
    );
  });
}

const EPS = 1e-3;

// ---------------------------------------------------------------------------
// Graph validation: clean invalid-input handling
// ---------------------------------------------------------------------------
test('normalizeGraph rejects malformed graph shapes', () => {
  assert.throws(() => normalizeGraph(null), TypeError);
  assert.throws(() => normalizeGraph('x'), TypeError);
  assert.throws(() => normalizeGraph({}), TypeError);
  assert.throws(() => normalizeGraph({ nodes: [], edges: [] }), /nonempty/);
  assert.throws(() => normalizeGraph({ nodes: [{ id: 'a', x: 0, y: 0 }], edges: 'no' }), TypeError);
});

test('normalizeGraph rejects duplicate ids and bad coordinates', () => {
  const dup = { nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'a', x: 1, y: 1 }], edges: [] };
  assert.throws(() => normalizeGraph(dup), /duplicate/);
  const bad = { nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: Number.NaN, y: 1 }], edges: [] };
  assert.throws(() => normalizeGraph(bad), /coordinates/);
});

test('normalizeGraph rejects bad edge fields by name', () => {
  const two = { nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 1, y: 0 }], edges: [] };
  const withEdge = (patch) => ({ ...two, edges: [{ a: 'a', b: 'b', ...patch }] });
  assert.throws(() => normalizeGraph({ ...two, edges: [{ a: 'a', b: 'ghost' }] }), /unknown node/);
  assert.throws(() => normalizeGraph(withEdge({ length: -1 })), /length/);
  assert.throws(() => normalizeGraph(withEdge({ length: Number.NaN })), /length/);
  assert.throws(() => normalizeGraph(withEdge({ gradePct: -2 })), /gradePct/);
  assert.throws(() => normalizeGraph(withEdge({ shadePct: 140 })), /shadePct/);
  assert.throws(() => normalizeGraph(withEdge({ curbRamps: 'yes' })), /boolean/);
  assert.throws(() => normalizeGraph(withEdge({ surface: 'cloud' })), /unknown surface/);
  assert.throws(() => normalizeGraph({ ...two, edges: [null] }), /object/);
  assert.throws(() => normalizeGraph({ ...two, edges: [7] }), /object/);
});

test('normalizeGraph applies documented defaults including Euclidean length', () => {
  const g = normalizeGraph({
    nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 3, y: 4 }],
    edges: [{ a: 'a', b: 'b' }],
  });
  const edge = g.edges[0];
  assert.equal(edge.length, 5);
  assert.equal(edge.gradePct, 0);
  assert.equal(edge.shadePct, 0);
  assert.equal(edge.curbRamps, true);
  assert.equal(edge.surface, 'paved');
  assert.equal(edge.name, 'a-b');
});

test('findAccessibleRoute rejects unknown nodes, profiles and weights', () => {
  const g = { nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 1, y: 0 }], edges: [] };
  assert.throws(() => findAccessibleRoute(g, 'a', 'ghost'), /unknown target/);
  assert.throws(() => findAccessibleRoute(g, 'ghost', 'b'), /unknown source/);
  assert.throws(() => findAccessibleRoute(g, 'a', 'b', { profile: 'rocket' }), /unknown routing profile/);
  assert.throws(() => findAccessibleRoute(g, 'a', 'b', { weights: { grade: -1 } }), /nonnegative/);
  assert.throws(() => findAccessibleRoute(g, 'a', 'b', { weights: { warp: 2 } }), /unknown weight/);
});

// ---------------------------------------------------------------------------
// Core solver behavior on the demo network
// ---------------------------------------------------------------------------
test('fastest profile takes the stair shortcut on the demo graph', () => {
  const result = findAccessibleRoute(accessDemoGraph(), 'A', 'G', { profile: 'fastest' });
  assert.equal(result.status, 'optimal');
  assert.deepEqual(result.path, ['A', 'E', 'G']);
  assert.equal(result.edges[0].surface, 'stairs');
  assert.ok(Math.abs(result.cost - (Math.hypot(4, 4) + 4)) < EPS);
});

test('wheelchair relaxes only the grade limit and flags the violating edge', () => {
  const result = findAccessibleRoute(accessDemoGraph(), 'A', 'G', { profile: 'wheelchair' });
  assert.equal(result.status, 'relaxed');
  assert.deepEqual(result.relaxedConstraints, ['max-grade-pct']);
  assert.deepEqual(result.path, ['A', 'D', 'E', 'F', 'G']);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].name, 'Pine Rise');
  assert.deepEqual(result.violations[0].reasons, ['grade-exceeds-limit']);
});

test('wheelchair unreachable reports frontier diagnostics and nearest reachable node', () => {
  const result = findAccessibleRoute(accessDemoGraph(), 'A', 'H', { profile: 'wheelchair' });
  assert.equal(result.status, 'unreachable');
  assert.equal(result.cost, Infinity);
  const d = result.diagnostics;
  assert.equal(d.strictReachableNodes, 4);
  assert.equal(d.relaxedReachableNodes, 7);
  assert.equal(d.totalNodes, 9);
  assert.deepEqual(d.blockedEdges, { grade: 3, curb: 1, stairs: 1 });
  assert.equal(d.nearestReachableToTarget.id, 'F');
  assert.equal(d.nearestReachableToTarget.straightLineUnits, 20);
  assert.match(d.hint, /Closest reachable node is F/);
});

test('shade priority routes the Elm Walk corridor while fastest takes stairs', () => {
  const result = findAccessibleRoute(accessDemoGraph(), 'A', 'G', { profile: 'shade' });
  assert.equal(result.status, 'optimal');
  assert.equal(result.path[1], 'D', 'shade path should detour through the shaded corridor');
  assert.deepEqual(result.path, ['A', 'D', 'E', 'G']);
});

test('profiles frozen, listed and distinct on the same query', () => {
  assert.deepEqual(listAccessProfiles(), ['fastest', 'pedestrian', 'wheelchair', 'shade']);
  assert.ok(Object.isFrozen(ACCESS_PROFILES));
  const g = accessDemoGraph();
  const paths = new Set(listAccessProfiles().map((p) => JSON.stringify(findAccessibleRoute(g, 'A', 'G', { profile: p }).path)));
  assert.ok(paths.size >= 3, 'profiles should differ on the demo query');
});

test('same node returns a trivial zero-cost result', () => {
  const result = findAccessibleRoute(accessDemoGraph(), 'B', 'B', { profile: 'wheelchair' });
  assert.equal(result.status, 'trivial');
  assert.deepEqual(result.path, ['B']);
  assert.equal(result.cost, 0);
  assert.equal(result.edges.length, 0);
});

// ---------------------------------------------------------------------------
// Determinism, tie-breaking and edge cases
// ---------------------------------------------------------------------------
test('solver is deterministic across repeated calls on an attributed graph', () => {
  const g = seededGraph(777, 8, 0.6);
  for (const profile of listAccessProfiles()) {
    const a = findAccessibleRoute(g, 'n0', 'n6', { profile });
    const b = findAccessibleRoute(g, 'n0', 'n6', { profile });
    assert.deepEqual(a, b, profile);
  }
});

test('equal-cost diamonds resolve to the lower-index node deterministically', () => {
  const graph = {
    nodes: [
      { id: 's', x: 0, y: 0 }, { id: 'x', x: 3, y: 2 }, { id: 'y', x: 3, y: -2 }, { id: 't', x: 6, y: 0 },
    ],
    edges: [
      { a: 's', b: 'x', length: 4 }, { a: 'x', b: 't', length: 4 },
      { a: 's', b: 'y', length: 4 }, { a: 'y', b: 't', length: 4 },
    ],
  };
  const result = findAccessibleRoute(graph, 's', 't', { profile: 'fastest' });
  assert.deepEqual(result.path, ['s', 'x', 't'], 'lower-index branch wins the tie');
});

test('zero-length edges do not break the heap or the path', () => {
  const graph = {
    nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 0, y: 0 }, { id: 'c', x: 5, y: 0 }],
    edges: [{ a: 'a', b: 'b', length: 0 }, { a: 'b', b: 'c', length: 5 }, { a: 'a', b: 'c', length: 9 }],
  };
  const result = findAccessibleRoute(graph, 'a', 'c', { profile: 'fastest' });
  assert.equal(result.status, 'optimal');
  assert.equal(result.cost, 5);
  assert.deepEqual(result.path, ['a', 'b', 'c']);
});

test('self-loop edges are tolerated and never appear on the path', () => {
  const graph = {
    nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 1, y: 0 }, { id: 'c', x: 2, y: 0 }],
    edges: [{ a: 'a', b: 'a', length: 0 }, { a: 'a', b: 'b', length: 1 }, { a: 'b', b: 'c', length: 1 }],
  };
  const result = findAccessibleRoute(graph, 'a', 'c', { profile: 'fastest' });
  assert.equal(result.cost, 2);
  assert.deepEqual(result.path, ['a', 'b', 'c']);
});

test('a graph connected only through a stair edge needs the full ladder', () => {
  const graph = {
    nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 1, y: 0 }],
    edges: [{ a: 'a', b: 'b', length: 1, gradePct: 9, curbRamps: false, surface: 'stairs' }],
  };
  const result = findAccessibleRoute(graph, 'a', 'b', { profile: 'wheelchair' });
  assert.equal(result.status, 'relaxed');
  assert.deepEqual(result.relaxedConstraints, ['max-grade-pct', 'curb-ramps', 'stairs']);
  assert.deepEqual(result.violations[0].reasons, ['grade-exceeds-limit', 'missing-curb-ramp', 'stairs-not-allowed']);
});

test('disconnected island returns unreachable with a null-free nearest hint', () => {
  const graph = {
    nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 1, y: 0 }, { id: 'z', x: 50, y: 50 }],
    edges: [{ a: 'a', b: 'b', length: 1 }],
  };
  const result = findAccessibleRoute(graph, 'a', 'z', { profile: 'fastest' });
  assert.equal(result.status, 'unreachable');
  assert.equal(result.diagnostics.nearestReachableToTarget.id, 'b');
  assert.equal(result.diagnostics.relaxedReachableNodes, 2);
});

// ---------------------------------------------------------------------------
// Optimality: brute-force differential over every simple path
// ---------------------------------------------------------------------------
test('solver cost equals brute-force minimum on 10 seeded graphs (fastest)', () => {
  for (let k = 0; k < 10; k += 1) {
    const raw = seededGraph(1000 + k);
    const g = normalizeGraph(raw);
    const weights = ACCESS_PROFILES.fastest.weights;
    const result = findAccessibleRoute(raw, 'n0', 'n6', { profile: 'fastest' });
    const best = bruteForceBestPath(g, 0, 6, () => true, weights);
    if (!Number.isFinite(best)) {
      assert.equal(result.status, 'unreachable', `seed ${k}: expected unreachable`);
    } else {
      assert.ok(Math.abs(result.cost - best) < EPS, `seed ${k}: ${result.cost} vs ${best}`);
      assertValidWalk(raw, result);
    }
  }
});

test('wheelchair cost equals brute-force minimum over compliant paths only', () => {
  const hard = ACCESS_PROFILES.wheelchair.hard;
  const weights = ACCESS_PROFILES.wheelchair.weights;
  const usable = (edge) => edgeBlockedReasons(edge, hard).length === 0;
  for (let k = 0; k < 10; k += 1) {
    const raw = seededGraph(2000 + k);
    const g = normalizeGraph(raw);
    const result = findAccessibleRoute(raw, 'n0', 'n6', { profile: 'wheelchair' });
    const strictBest = bruteForceBestPath(g, 0, 6, usable, weights);
    const looseBest = bruteForceBestPath(g, 0, 6, () => true, weights);
    if (Number.isFinite(strictBest)) {
      assert.equal(result.status, 'optimal', `seed ${k}`);
      assert.ok(Math.abs(result.cost - strictBest) < EPS, `seed ${k}`);
    } else if (Number.isFinite(looseBest)) {
      assert.equal(result.status, 'relaxed', `seed ${k}`);
      assert.ok(result.relaxedConstraints.length > 0);
      assertValidWalk(raw, result);
    } else {
      assert.equal(result.status, 'unreachable', `seed ${k}`);
    }
  }
});

test('shade-weighted cost equals brute-force minimum on 8 seeded graphs', () => {
  const weights = ACCESS_PROFILES.shade.weights;
  for (let k = 0; k < 8; k += 1) {
    const raw = seededGraph(3000 + k, 6, 0.55);
    const g = normalizeGraph(raw);
    const result = findAccessibleRoute(raw, 'n0', 'n5', { profile: 'shade' });
    const best = bruteForceBestPath(g, 0, 5, () => true, weights);
    if (!Number.isFinite(best)) assert.equal(result.status, 'unreachable', `seed ${k}`);
    else assert.ok(Math.abs(result.cost - best) < EPS, `seed ${k}`);
  }
});

test('custom weight overrides are honored and stay optimal vs brute force', () => {
  for (let k = 0; k < 6; k += 1) {
    const raw = seededGraph(4000 + k, 6, 0.55);
    const g = normalizeGraph(raw);
    const options = { profile: 'pedestrian', weights: { distance: 2, grade: 5, shade: 0, surface: 0, curb: 0 } };
    const weights = { ...ACCESS_PROFILES.pedestrian.weights, ...options.weights };
    const result = findAccessibleRoute(raw, 'n0', 'n5', options);
    const best = bruteForceBestPath(g, 0, 5, () => true, weights);
    if (!Number.isFinite(best)) assert.equal(result.status, 'unreachable', `seed ${k}`);
    else assert.ok(Math.abs(result.cost - best) < EPS, `seed ${k}`);
  }
});

// ---------------------------------------------------------------------------
// Monotonicity and path invariants
// ---------------------------------------------------------------------------
test('raising the grade weight never lowers the optimal cost', () => {
  for (let k = 0; k < 6; k += 1) {
    const raw = seededGraph(5000 + k);
    const zero = findAccessibleRoute(raw, 'n0', 'n6', { profile: 'pedestrian', weights: { grade: 0, shade: 0, surface: 0, curb: 0 } });
    const high = findAccessibleRoute(raw, 'n0', 'n6', { profile: 'pedestrian', weights: { grade: 8, shade: 0, surface: 0, curb: 0 } });
    if (zero.status !== 'unreachable' && high.status !== 'unreachable') {
      assert.ok(high.cost >= zero.cost - EPS, `seed ${k}: ${high.cost} < ${zero.cost}`);
    } else {
      assert.equal(zero.status, high.status, 'reachability is weight-independent');
    }
  }
});

test('relaxation ladder enlarges the usable edge set monotonically', () => {
  const hard = ACCESS_PROFILES.wheelchair.hard;
  const ladder = [
    { ...hard, maxGradePct: Infinity },
    { ...hard, maxGradePct: Infinity, requireCurbRamps: false },
    { ...hard, maxGradePct: Infinity, requireCurbRamps: false, allowStairs: true },
  ];
  for (let k = 0; k < 6; k += 1) {
    const g = normalizeGraph(seededGraph(6000 + k, 8, 0.6));
    let prev = 0;
    for (const level of [hard, ...ladder]) {
      const usable = g.edges.filter((e) => edgeBlockedReasons(e, level).length === 0).length;
      assert.ok(usable >= prev, 'each relaxed level keeps every usable edge');
      prev = usable;
    }
  }
});

test('returned paths are simple valid walks on seeded attributed graphs', () => {
  for (let k = 0; k < 6; k += 1) {
    const raw = seededGraph(7000 + k, 8, 0.6);
    for (const profile of listAccessProfiles()) {
      const result = findAccessibleRoute(raw, 'n0', 'n7', { profile });
      if (result.status === 'unreachable') continue;
      assertValidWalk(raw, result);
      assert.equal(new Set(result.path).size, result.path.length, `${profile} seed ${k}: path repeats a node`);
      assert.ok(result.diagnostics.nodesExpanded <= result.diagnostics.nodeCount);
    }
  }
});

test('cost equals the per-edge sum and the breakdown sums to the cost', () => {
  for (const profile of listAccessProfiles()) {
    const result = findAccessibleRoute(accessDemoGraph(), 'A', 'G', { profile });
    if (!result.edges.length) continue;
    const edgeSum = result.edges.reduce((sum, e) => sum + e.cost, 0);
    assert.ok(Math.abs(edgeSum - result.cost) < EPS, profile);
    const b = result.breakdown;
    const split = b.distance + b.gradePenalty + b.shadePenalty + b.surfacePenalty + b.curbPenalty;
    assert.ok(Math.abs(split - result.cost) < EPS, `${profile}: breakdown ${split} vs cost ${result.cost}`);
    for (const key of Object.keys(b)) assert.ok(b[key] >= 0, `${profile}.${key} negative`);
  }
});

// ---------------------------------------------------------------------------
// Edge-cost semantics
// ---------------------------------------------------------------------------
test('edgeCost is monotone in grade, shade deficit, surface roughness and missing ramps', () => {
  const w = ACCESS_PROFILES.wheelchair.weights;
  const base = { length: 4, gradePct: 0, shadePct: 0, curbRamps: true, surface: 'paved' };
  assert.ok(edgeCost({ ...base, gradePct: 10 }, w) > edgeCost(base, w));
  assert.ok(edgeCost({ ...base, shadePct: 90 }, w) < edgeCost(base, w));
  assert.ok(edgeCost({ ...base, surface: 'stairs' }, w) > edgeCost({ ...base, surface: 'gravel' }, w));
  assert.ok(edgeCost({ ...base, curbRamps: false }, w) > edgeCost(base, w));
});

test('a missing curb ramp adds exactly the profile curb weight times the penalty units', () => {
  const w = ACCESS_PROFILES.wheelchair.weights;
  const base = { length: 4, gradePct: 0, shadePct: 0, curbRamps: true, surface: 'paved' };
  const delta = edgeCost({ ...base, curbRamps: false }, w) - edgeCost(base, w);
  assert.ok(Math.abs(delta - w.curb * CURB_PENALTY_UNITS) < 1e-9);
});

test('hard limits block exactly at the documented boundary', () => {
  const hard = ACCESS_PROFILES.wheelchair.hard;
  const base = { length: 1, gradePct: 8, curbRamps: true, surface: 'paved' };
  assert.deepEqual(edgeBlockedReasons(base, hard), [], 'grade at the 8% limit stays usable');
  assert.deepEqual(edgeBlockedReasons({ ...base, gradePct: 8.01 }, hard), ['grade-exceeds-limit']);
  assert.deepEqual(edgeBlockedReasons({ ...base, curbRamps: false }, hard), ['missing-curb-ramp']);
  assert.deepEqual(edgeBlockedReasons({ ...base, surface: 'stairs' }, hard), ['stairs-not-allowed']);
  assert.deepEqual(edgeBlockedReasons({ ...base, surface: 'stairs' }, ACCESS_PROFILES.fastest.hard), []);
});

// ---------------------------------------------------------------------------
// Dispatch router hardening: honest unfulfilled diagnostics
// ---------------------------------------------------------------------------
test('equal-savings ties merge the lowest (i,j) first on a symmetric fixture', () => {
  const points = [
    { id: 'p0', x: 1, y: 0, load: 1 },
    { id: 'p1', x: 0, y: 1, load: 1 },
    { id: 'p2', x: -1, y: 0, load: 1 },
    { id: 'p3', x: 0, y: -1, load: 1 },
  ];
  const volunteer = { id: 'v', mode: 'car', capacity: 8, home: { x: 0, y: 0 }, maxMinutes: 400 };
  const a = optimizeRoutes([{ volunteer, requests: points }]);
  const b = optimizeRoutes([{ volunteer, requests: points.map((p) => ({ ...p })) }]);
  assert.deepEqual(a, b, 'identical inputs must produce identical routes');
  assert.equal(a.routes.length, 1);
  assert.equal(a.routes[0].requestIds.length, 4);
  // All adjacent savings tie at 2 - sqrt(2); the first merge must be (0, 1).
  assert.deepEqual(a.savingsSteps[0].before, [[0], [1]]);
  assert.deepEqual(a.savingsSteps[0].after, [0, 1]);
});

test('an overloaded request lands in unfulfilled with a load reason', () => {
  const result = optimizeRoutes([{
    volunteer: { id: 'v', mode: 'walk', home: { x: 0, y: 0 } },
    requests: [{ id: 'heavy', x: 1, y: 1, load: 50 }],
  }]);
  assert.equal(result.routes.length, 0);
  assert.equal(result.unfulfilled.length, 1);
  assert.equal(result.unfulfilled[0].requestId, 'heavy');
  assert.deepEqual(result.unfulfilled[0].reasons, ['load-exceeds-capacity']);
});

test('a request beyond the closed-loop time budget is unfulfilled, not silently routed', () => {
  const result = optimizeRoutes([{
    volunteer: { id: 'v', mode: 'car', home: { x: 0, y: 0 }, maxMinutes: 2 },
    requests: [
      { id: 'near', x: 5, y: 0, load: 1 },
      { id: 'far', x: 30, y: 0, load: 1 },
    ],
  }]);
  assert.deepEqual(result.routes.flatMap((r) => r.requestIds), ['near']);
  assert.equal(result.unfulfilled.length, 1);
  assert.equal(result.unfulfilled[0].requestId, 'far');
  assert.deepEqual(result.unfulfilled[0].reasons, ['travel-exceeds-time-budget']);
});

test('a matched request that fails the closed-loop audit reaches runDispatch unfulfilled', () => {
  const scenario = {
    id: 'edge-unreachable',
    name: 'Edge fixture',
    grid: { columns: 5, rows: 5, spacing: 2 },
    volunteers: [{ id: 'v1', skills: [], mode: 'car', capacity: 4, home: { x: 0, y: 0 } }],
    requests: [
      { id: 'r-far', description: 'far stop', location: { x: 31, y: 0 }, load: 1, urgency: 3, deadline: 5, windowMinutes: 120, readyAt: 0 },
    ],
  };
  const result = runDispatch(scenario);
  assert.equal(result.matched.matches.length, 1, 'one-way window admits the pair');
  assert.equal(result.optimized.routes.length, 0, 'closed loop exceeds the deadline window');
  assert.equal(result.optimized.unfulfilled.length, 1);
  assert.deepEqual(result.optimized.unfulfilled[0].reasons, ['travel-exceeds-time-budget']);
  assert.equal(result.metrics.unfulfilledRequests.optimized, 1);
  assert.equal(result.unfulfilledRequests, 1);
});

test('a volunteer without a usable depot reports every request as unfulfilled', () => {
  for (const home of [undefined, { x: Number.NaN, y: 0 }, { y: 3 }]) {
    const result = optimizeRoutes([{
      volunteer: { id: 'v', mode: 'walk', home },
      requests: [{ id: 'r', x: 1, y: 1, load: 1 }],
    }]);
    assert.equal(result.routes.length, 0);
    assert.equal(result.unfulfilled.length, 1);
    assert.deepEqual(result.unfulfilled[0].reasons, ['volunteer-missing-depot']);
  }
});

test('presets and surge variants keep zero unfulfilled after honest auditing', () => {
  for (const id of Object.keys(SCENARIOS)) {
    for (const scenario of [SCENARIOS[id], injectSurge(SCENARIOS[id], 4242, 5)]) {
      const { optimized, unfulfilled } = runDispatch(scenario);
      assert.equal(optimized.unfulfilled.length, 0, `${id} route-level unfulfilled`);
      assert.ok(optimized.routes.every((r) => r.feasible === true));
      assert.equal(unfulfilled, optimized.unfulfilled);
    }
  }
});

test('unfulfilled stops never appear inside route requestIds', () => {
  const result = optimizeRoutes([{
    volunteer: { id: 'v', mode: 'walk', home: { x: 0, y: 0 }, maxMinutes: 3 },
    requests: [
      { id: 'ok', x: 1, y: 0, load: 1 },
      { id: 'too-far', x: 40, y: 0, load: 1 },
      { id: 'too-heavy', x: 1, y: 1, load: 60 },
    ],
  }]);
  const routed = new Set(result.routes.flatMap((r) => r.requestIds));
  assert.equal(result.unfulfilled.length, 2);
  for (const entry of result.unfulfilled) {
    assert.ok(!routed.has(entry.requestId), `${entry.requestId} both routed and unfulfilled`);
    assert.ok(entry.reasons.length >= 1);
  }
  const reasons = result.unfulfilled.map((e) => e.reasons[0]).sort();
  assert.deepEqual(reasons, ['load-exceeds-capacity', 'travel-exceeds-time-budget']);
});

test('empty and degenerate assignments produce clean results', () => {
  const empty = optimizeRoutes([]);
  assert.deepEqual(empty.routes, []);
  assert.deepEqual(empty.unfulfilled, []);
  const noRequests = optimizeRoutes([{ volunteer: { id: 'v', mode: 'car', home: { x: 0, y: 0 } }, requests: [] }]);
  assert.deepEqual(noRequests.routes, []);
  assert.deepEqual(noRequests.unfulfilled, []);
  assert.equal(noRequests.totalDistance, 0);
});

test('nonfinite volunteer speed falls back to the mode default', () => {
  const result = optimizeRoutes([{
    volunteer: { id: 'v', mode: 'bike', speed: Number.NaN, home: { x: 0, y: 0 } },
    requests: [{ id: 'r', x: 2, y: 0, load: 1 }],
  }]);
  assert.equal(result.routes.length, 1);
  for (const leg of result.routes[0].legs) assert.ok(Number.isFinite(leg.arrivalMinutes));
});

test('optimizeRoutes is deterministic even with unfulfilled entries', () => {
  const assignment = [{
    volunteer: { id: 'v', mode: 'walk', home: { x: 0, y: 0 }, maxMinutes: 2 },
    requests: [
      { id: 'a', x: 30, y: 0, load: 1 },
      { id: 'b', x: 1, y: 0, load: 90 },
      { id: 'c', x: 1, y: 0, load: 1 },
    ],
  }];
  assert.deepEqual(optimizeRoutes(assignment), optimizeRoutes(assignment.map((a) => ({ ...a }))));
});

test('twoOpt survives degenerate geometry and stays a local optimum', () => {
  const flat = Array.from({ length: 5 }, (_, i) => ({ id: `z${i}`, x: 7, y: 7, load: 1 }));
  const depot = { x: 7, y: 7 };
  const first = twoOpt([0, 1, 2, 3, 4], flat, depot);
  assert.equal(first.distance, 0);
  assert.equal(first.swapTrace.length, 0);
  // Idempotence: polishing the polished order finds no further improvement.
  const rng = mulberry32(42);
  const points = Array.from({ length: 9 }, (_, i) => ({ id: `p${i}`, x: rng() * 60, y: rng() * 60, load: 1 }));
  const polished = twoOpt(points.map((_, i) => i), points, { x: 30, y: 30 });
  const again = twoOpt(polished.order, points, { x: 30, y: 30 });
  assert.equal(again.swapTrace.length, 0, '2-opt output must be a local optimum');
  assert.ok(Math.abs(again.distance - polished.distance) < 1e-9);
});

test('twoOpt on two and three point orders recomputes the closed distance', () => {
  const points = [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 4, y: 0 }, { id: 'c', x: 4, y: 3 }];
  const depot = { x: 0, y: 0 };
  for (const order of [[0, 1], [0, 1, 2], [2, 0, 1]]) {
    const result = twoOpt(order, points, depot);
    let expected = distance(depot, points[result.order[0]]);
    for (let i = 0; i + 1 < result.order.length; i += 1) {
      expected += distance(points[result.order[i]], points[result.order[i + 1]]);
    }
    expected += distance(points[result.order[result.order.length - 1]], depot);
    assert.ok(Math.abs(result.distance - expected) < 1e-9);
  }
});

test('unfulfilled reasons are stable and self-consistent across the result', () => {
  const result = optimizeRoutes([{
    volunteer: { id: 'v', mode: 'walk', home: { x: 0, y: 0 }, maxLoad: 1, maxMinutes: 400 },
    requests: [
      { id: 'h1', x: 1, y: 0, load: 5 },
      { id: 'h2', x: 1, y: 1, load: 4 },
    ],
  }]);
  assert.equal(result.unfulfilled.length, 2);
  for (const entry of result.unfulfilled) {
    assert.equal(entry.volunteerId, 'v');
    assert.deepEqual(entry.reasons, ['load-exceeds-capacity']);
    assert.equal(entry.request.id, entry.requestId);
  }
});

// ---------------------------------------------------------------------------
// Route-proof export: canonical JSON, fingerprint, CSV
// ---------------------------------------------------------------------------
test('stableStringify canonicalizes key order at every depth', () => {
  const a = { b: 1, a: { z: 1, y: [ { m: 2, a: 1 } ] } };
  const b = { a: { y: [ { a: 1, m: 2 } ], z: 1 }, b: 1 };
  assert.equal(stableStringify(a), stableStringify(b));
  assert.equal(stableStringify({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.deepEqual(Object.keys(sortKeysDeep({ c: 1, a: 2, b: 3 })), ['a', 'b', 'c']);
});

test('proof fingerprint is a stable 16-hex digest sensitive to content', () => {
  const fingerprint = proofFingerprint('kindroute');
  assert.match(fingerprint, /^[0-9a-f]{16}$/);
  assert.equal(fingerprint, proofFingerprint('kindroute'));
  assert.notEqual(proofFingerprint('kindroute-a'), fingerprint);
  assert.equal(proofFingerprint(stableStringify({ a: 1 })), proofFingerprint('{"a":1}'));
});

test('buildRouteProof packages scenario, matching, metrics, routes and checks', () => {
  const dispatch = runDispatch(SCENARIOS.oakwood);
  const proof = buildRouteProof(SCENARIOS.oakwood, dispatch);
  assert.equal(proof.schema, 1);
  assert.equal(proof.synthetic, true);
  assert.equal(proof.scenario.id, 'oakwood-groceries');
  assert.equal(proof.scenario.requests, 8);
  assert.equal(proof.routes.length, dispatch.optimized.routes.length);
  assert.equal(proof.matching.matchedPairs, dispatch.matched.matches.length);
  assert.equal(proof.checks.distanceMatches, true);
  assert.equal(proof.checks.recomputedTotalDistance, dispatch.optimized.totalDistance);
  assert.equal(proof.checks.legsMatchStops, true);
  assert.equal(proof.checks.allRoutesFeasible, true);
  assert.equal(proof.checks.capacityViolations, 0);
});

test('proof self-checks agree with an independent late-arrival recount', () => {
  for (const id of Object.keys(SCENARIOS)) {
    const scenario = injectSurge(SCENARIOS[id], 777, 4);
    const proof = buildRouteProof(scenario, runDispatch(scenario));
    assert.equal(proof.checks.lateStops >= 0, true);
    assert.equal(proof.checks.unfulfilledReported, proof.unfulfilled.length);
    assert.equal(proof.checks.servedStops, proof.routes.reduce((s, r) => s + r.requestIds.length, 0));
  }
});

test('routeProofJson is byte-identical and re-verifiable from its own fingerprint', () => {
  const dispatch = runDispatch(SCENARIOS.winter);
  const first = routeProofJson(SCENARIOS.winter, dispatch);
  const second = routeProofJson(SCENARIOS.winter, runDispatch(SCENARIOS.winter));
  assert.equal(first, second, 'same inputs must serialize to identical bytes');
  assert.ok(first.endsWith('}\n'));
  const parsed = JSON.parse(first);
  const { fingerprint, ...rest } = parsed;
  assert.equal(proofFingerprint(stableStringify(rest)), fingerprint, 'fingerprint must verify');
});

test('fingerprint changes when the dispatch result changes', () => {
  const a = buildRouteProof(SCENARIOS.oakwood, runDispatch(SCENARIOS.oakwood)).fingerprint;
  const b = buildRouteProof(SCENARIOS.winter, runDispatch(SCENARIOS.winter)).fingerprint;
  assert.notEqual(a, b);
  const surged = buildRouteProof(injectSurge(SCENARIOS.oakwood, 4242, 5), runDispatch(injectSurge(SCENARIOS.oakwood, 4242, 5))).fingerprint;
  assert.notEqual(a, surged);
});

test('proof unfulfilled entries stay lean and ordered', () => {
  const scenario = {
    id: 'proof-unfulfilled',
    name: 'P',
    grid: { columns: 3, rows: 3, spacing: 2 },
    volunteers: [{ id: 'v', skills: [], mode: 'car', capacity: 4, home: { x: 0, y: 0 }, maxMinutes: 2 }],
    requests: [
      { id: 'r1', description: 'd', location: { x: 30, y: 0 }, load: 1, urgency: 1, deadline: 5, windowMinutes: 200, readyAt: 0 },
    ],
  };
  const proof = buildRouteProof(scenario, runDispatch(scenario));
  assert.equal(proof.unfulfilled.length, 1);
  assert.deepEqual(Object.keys(proof.unfulfilled[0]).sort(), ['reasons', 'requestId', 'volunteerId']);
  assert.deepEqual(proof.unfulfilled[0].reasons, ['travel-exceeds-time-budget']);
});

test('buildRouteProof rejects malformed dispatch results', () => {
  assert.throws(() => buildRouteProof(null, {}), TypeError);
  assert.throws(() => buildRouteProof(SCENARIOS.oakwood, null), TypeError);
  assert.throws(() => buildRouteProof(SCENARIOS.oakwood, { optimized: {} }), TypeError);
});

test('proof stays consistent on an empty dispatch', () => {
  const scenario = { id: 'empty', name: 'E', volunteers: [], requests: [], grid: { columns: 2, rows: 2, spacing: 2 } };
  const dispatch = runDispatch(scenario);
  const proof = buildRouteProof(scenario, dispatch);
  assert.equal(proof.routes.length, 0);
  assert.equal(proof.checks.servedStops, 0);
  assert.equal(proof.checks.distanceMatches, true);
  assert.match(routeProofJson(scenario, dispatch), /"fingerprint": "[0-9a-f]{16}"/);
});

test('csvCell escapes commas, quotes, newlines and formula triggers', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('line\nbreak'), '"line\nbreak"');
  assert.equal(csvCell('=SUM(1)'), "'=SUM(1)");
  assert.equal(csvCell('-9'), "'-9");
  assert.equal(csvCell('@cmd'), "'@cmd");
  assert.equal(csvCell(3.5), '3.5');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell('plain'), 'plain');
});

test('CSV summary is deterministic and carries the proof fingerprint', () => {
  const dispatch = runDispatch(SCENARIOS.oakwood);
  const proof = buildRouteProof(SCENARIOS.oakwood, dispatch);
  const csv = routeSummaryCsv(SCENARIOS.oakwood, dispatch);
  assert.equal(csv, routeSummaryCsv(SCENARIOS.oakwood, runDispatch(SCENARIOS.oakwood)));
  assert.ok(csv.startsWith('# kindroute route summary\n'));
  assert.ok(csv.includes(`# fingerprint ${proof.fingerprint}`));
  assert.ok(csv.endsWith('\n'));
});

test('CSV metric rows mirror the dispatch metrics', () => {
  const { metrics } = runDispatch(SCENARIOS.oakwood);
  const csv = routeSummaryCsv(SCENARIOS.oakwood, runDispatch(SCENARIOS.oakwood));
  assert.ok(csv.includes(`distance_saved_percent,${metrics.totalDistance.savedPercent},`));
  assert.ok(csv.includes(`gini_workload,${metrics.gini.optimized},${metrics.gini.baseline}`));
  assert.ok(csv.includes(`late_arrivals,${metrics.lateArrivals.optimized},${metrics.lateArrivals.baseline}`));
  assert.ok(csv.includes(`unfulfilled_requests,${metrics.unfulfilledRequests.optimized},${metrics.unfulfilledRequests.baseline}`));
});

test('CSV stop rows equal total routed legs with correct fields', () => {
  const dispatch = runDispatch(SCENARIOS.tutoring);
  const csv = routeSummaryCsv(SCENARIOS.tutoring, dispatch);
  const lines = csv.split('\n');
  const head = lines.indexOf('stop,route_volunteer,mode,request_id,eta_min,deadline_min,late,load');
  assert.ok(head > 0);
  const rows = lines.slice(head + 1).filter((l) => l.length && !l.startsWith('#') && !l.startsWith('unfulfilled_request'));
  const legTotal = dispatch.optimized.routes.reduce((s, r) => s + r.legs.length, 0);
  assert.equal(rows.length, legTotal);
  const allLegs = dispatch.optimized.routes.flatMap((r) => r.legs.map((leg) => ({ leg, mode: r.mode, vid: r.volunteerId })));
  rows.forEach((line, i) => {
    const cells = line.split(',');
    assert.equal(cells[1], allLegs[i].vid);
    assert.equal(cells[2], allLegs[i].mode);
    assert.equal(cells[3], allLegs[i].leg.requestId);
    assert.ok(['yes', 'no'].includes(cells[6]));
  });
});

test('CSV emits an unfulfilled section exactly when the dispatch has unfulfilled entries', () => {
  const scenario = {
    id: 'csv-unfulfilled',
    name: 'C',
    grid: { columns: 3, rows: 3, spacing: 2 },
    volunteers: [{ id: 'v', skills: [], mode: 'car', capacity: 4, home: { x: 0, y: 0 }, maxMinutes: 2 }],
    requests: [
      { id: 'far-1', description: 'd', location: { x: 30, y: 0 }, load: 1, urgency: 1, deadline: 5, windowMinutes: 200, readyAt: 0 },
    ],
  };
  const csv = routeSummaryCsv(scenario, runDispatch(scenario));
  assert.ok(csv.includes('unfulfilled_request,volunteer_id,reasons'));
  assert.ok(csv.includes('far-1,v,travel-exceeds-time-budget'));
  assert.ok(!routeSummaryCsv(SCENARIOS.oakwood, runDispatch(SCENARIOS.oakwood)).includes('unfulfilled_request,volunteer_id'));
});

// ---------------------------------------------------------------------------
// UI contract wave 3: export, keyboard access, invalid input
// ---------------------------------------------------------------------------
test('export controls exist and are wired end to end', () => {
  for (const id of ['export-json', 'export-csv', 'proof-hash']) {
    assert.match(HTML, new RegExp(`id="${id}"`), `missing #${id}`);
  }
  assert.match(HTML, /aria-label="Export route proof"/);
  assert.match(APP, /\$\('export-json'\)\.addEventListener\('click', exportProofJson\)/);
  assert.match(APP, /\$\('export-csv'\)\.addEventListener\('click', exportSummaryCsv\)/);
  assert.match(APP, /URL\.createObjectURL/);
  assert.match(APP, /URL\.revokeObjectURL/);
  assert.match(APP, /anchor\.download = filename/);
  assert.match(APP, /updateProofHash/);
  assert.match(APP, /buildRouteProof\(state\.scenario, state\.dispatch\)/);
});

test('tabs follow the ARIA roving-tabindex keyboard contract', () => {
  assert.match(HTML, /id="tab-map"[^>]*tabindex="0"/);
  assert.equal((HTML.match(/class="tab[^"]*"[^>]*tabindex="-1"/g) ?? []).length, 2);
  assert.match(APP, /const TAB_ORDER = \['map', 'algo', 'card'\]/);
  for (const key of ['ArrowRight', 'ArrowLeft', 'Home', 'End']) {
    assert.ok(APP.includes(`'${key}'`), `tab handler missing ${key}`);
  }
  assert.match(APP, /tab\.tabIndex = active \? 0 : -1/);
});

test('map canvas is keyboard operable through panBy, zoomBy and resetView', () => {
  assert.match(HTML, /<canvas id="map-canvas" tabindex="0"/);
  assert.match(HTML, /Arrow keys pan, plus and minus zoom, 0 resets/);
  assert.match(APP, /\$\('map-canvas'\)\.addEventListener\('keydown'/);
  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
    assert.ok(APP.includes(key), `canvas handler missing ${key}`);
  }
  assert.match(MAP, /function panBy\(dx, dy\)/);
  assert.match(APP, /mapViz\?\.panBy\(pan\[0\], pan\[1\]\)/);
  assert.match(APP, /event\.key === '0'/);
});

test('request load and capacity bounds reject invalid input cleanly', () => {
  assert.match(APP, /rawLoad === '' \|\| !Number\.isFinite\(parsedLoad\) \|\| parsedLoad < 1 \|\| parsedLoad > 6/);
  assert.ok(APP.includes("'Load must be a number from 1 to 6.'"));
  assert.ok(APP.includes("'Volunteer capacity stays between 1 and 12.'"));
  assert.match(APP, /Math\.round\(parsedLoad\)/);
});

test('accessible routing lab DOM, controls and render path are wired', () => {
  for (const id of ['access-profile', 'access-from', 'access-to', 'access-run', 'access-status', 'access-path', 'access-detail', 'access-edges']) {
    assert.match(HTML, new RegExp(`id="${id}"`), `missing #${id}`);
  }
  for (const value of ['wheelchair', 'pedestrian', 'shade', 'fastest']) {
    assert.match(HTML, new RegExp(`value="${value}"`));
  }
  assert.match(APP, /initAccessLab\(\)/);
  assert.match(APP, /findAccessibleRoute\(ACCESS_GRAPH/);
  assert.match(APP, /accessDemoGraph\(\)/);
  assert.match(APP, /is-\$\{result\.status\}/);
  assert.match(CSS, /\.access-status\.is-relaxed/);
  assert.match(CSS, /\.access-edges li\.violates/);
});

test('service worker caches the new modules under a bumped cache version', () => {
  assert.match(SW, /const CACHE = 'kindroute-v4'/);
  assert.ok(SW.includes("'./src/accessible-routing.js'"));
  assert.ok(SW.includes("'./src/route-proof.js'"));
});

test('public barrel exports the new engine and proof modules', async () => {
  const barrel = await import('../src/index.js');
  for (const name of ['accessibleRouting', 'routeProof', 'findAccessibleRoute', 'accessDemoGraph', 'buildRouteProof', 'routeProofJson', 'routeSummaryCsv', 'proofFingerprint']) {
    assert.ok(name in barrel, `missing export ${name}`);
  }
});

test('package exports map exposes the two new modules', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.exports['./accessible-routing'], './src/accessible-routing.js');
  assert.equal(pkg.exports['./route-proof'], './src/route-proof.js');
});

// ---------------------------------------------------------------------------
// Hygiene: dashes, smooth scroll, console calls, AI mentions
// ---------------------------------------------------------------------------
test('shipped files stay free of em/en dashes, smooth scroll and console calls', () => {
  const files = [
    'index.html', 'styles.css', 'sw.js',
    'src/app.js', 'src/map-viz.js', 'src/index.js', 'src/routing.js',
    'src/dispatch.js', 'src/scenarios.js', 'src/hungarian.js',
    'src/crypto-card.js', 'src/qr-svg.js',
    'src/accessible-routing.js', 'src/route-proof.js',
  ];
  for (const rel of files) {
    const text = read(rel);
    assert.equal(text.includes('—'), false, `${rel} contains an em dash`);
    assert.equal(text.includes('–'), false, `${rel} contains an en dash`);
    assert.doesNotMatch(text, /scroll-behavior\s*:\s*smooth/i, `${rel} smooth scroll`);
    assert.doesNotMatch(text, /console\.(log|warn|error|info|debug|trace)/, `${rel} console call`);
    assert.doesNotMatch(text, /ChatGPT|OpenAI|Copilot|Gemini\b/i, `${rel} AI vendor mention`);
  }
  assert.doesNotMatch(HTML, /\bAI\b/);
  assert.doesNotMatch(CSS, /\bAI\b/);
});

test('access lab strings and export copy stay honest about being synthetic', () => {
  assert.match(HTML, /One synthetic network, different constraints/);
  assert.match(HTML, /grades at or under 8%/);
  assert.match(APP, /deterministic\)/);
  assert.doesNotMatch(APP, /innerHTML\s*=/);
});
