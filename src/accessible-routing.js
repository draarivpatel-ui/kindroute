/**
 * Multi-objective accessible street-graph router.
 *
 * A second routing engine beside the dispatch planner: instead of assigning
 * volunteers it finds a single best path across an attributed street graph
 * where every edge carries a length, a steepness grade, a shade coverage
 * fraction, a curb-ramp flag and a surface class. Profiles combine those
 * attributes into one deterministic weighted cost, and hard accessibility
 * limits (maximum grade, required curb ramps, stairs allowed) prune edges
 * outright. When strict constraints leave a destination unreachable, a
 * relaxation ladder lifts one limit at a time in a fixed order and reports
 * exactly which constraints had to give; when even the relaxed graph cannot
 * connect, the result carries a structured unreachable diagnostic instead of
 * an empty answer.
 *
 * Shortest paths use Dijkstra over a binary heap with deterministic
 * tie-breaking: equal-cost candidates pop in insertion order and adjacency is
 * scanned in node-index order, so repeated calls on identical input are
 * reproducible. Edge costs are always nonnegative, so results are simple
 * paths. All inputs are validated up front with TypeErrors naming the bad
 * field; there is no Math.random and no wall clock anywhere.
 */

/** Travel roughness multiplier per surface class. Stairs are passable but costly. */
export const SURFACE_FACTORS = Object.freeze({
  paved: 1, asphalt: 1, concrete: 1, gravel: 1.5, grass: 2.2, stairs: 9,
});

/** Fixed added cost in grid units for crossing an edge with no usable curb ramp. */
export const CURB_PENALTY_UNITS = 3;

/**
 * Built-in routing profiles. `weights` feed the soft multi-objective cost:
 *   edgeCost = length * (wDistance + wGrade * gradePct / 10
 *              + wShade * (1 - shadePct / 100) + wSurface * (surfaceFactor - 1))
 *              + wCurb * (curbRamps ? 0 : CURB_PENALTY_UNITS)
 * `hard` fields prune edges outright before weighting.
 */
export const ACCESS_PROFILES = Object.freeze({
  fastest: Object.freeze({
    id: 'fastest',
    label: 'Fastest',
    hard: Object.freeze({ maxGradePct: Infinity, requireCurbRamps: false, allowStairs: true }),
    weights: Object.freeze({ distance: 1, grade: 0, shade: 0, surface: 0, curb: 0 }),
  }),
  pedestrian: Object.freeze({
    id: 'pedestrian',
    label: 'Pedestrian',
    hard: Object.freeze({ maxGradePct: Infinity, requireCurbRamps: false, allowStairs: true }),
    weights: Object.freeze({ distance: 1, grade: 0.35, shade: 0.5, surface: 0.5, curb: 0.75 }),
  }),
  wheelchair: Object.freeze({
    id: 'wheelchair',
    label: 'Wheelchair',
    hard: Object.freeze({ maxGradePct: 8, requireCurbRamps: true, allowStairs: false }),
    weights: Object.freeze({ distance: 1, grade: 2.5, shade: 0.25, surface: 1.5, curb: 4 }),
  }),
  shade: Object.freeze({
    id: 'shade',
    label: 'Shade priority',
    hard: Object.freeze({ maxGradePct: Infinity, requireCurbRamps: false, allowStairs: true }),
    weights: Object.freeze({ distance: 1, grade: 0.1, shade: 3, surface: 0.25, curb: 0.25 }),
  }),
});

/** Ids of the built-in profiles in stable order. */
export function listAccessProfiles() {
  return Object.keys(ACCESS_PROFILES);
}

/**
 * Validate and normalize an attributed street graph.
 *
 * @param {object} input `{ nodes: [{id, x, y}], edges: [{a, b, ...}] }`
 *   Edges are undirected. Optional per-edge attributes:
 *   `length` (defaults to Euclidean node distance, must be nonnegative),
 *   `gradePct` (nonnegative), `shadePct` (0 to 100), `curbRamps` (boolean,
 *   default true), `surface` (key of SURFACE_FACTORS, default 'paved'),
 *   `name` (default `${a}-${b}`).
 * @returns {object} normalized graph with sorted adjacency for deterministic
 *   scanning. Throws TypeError naming the offending field on bad input.
 */
export function normalizeGraph(input) {
  if (!input || typeof input !== 'object') throw new TypeError('graph must be an object');
  const { nodes, edges } = input;
  if (!Array.isArray(nodes) || nodes.length === 0) throw new TypeError('graph.nodes must be a nonempty array');
  if (!Array.isArray(edges)) throw new TypeError('graph.edges must be an array');

  const index = new Map();
  const normNodes = nodes.map((node, i) => {
    if (!node || typeof node.id !== 'string' || node.id.length === 0) {
      throw new TypeError(`node ${i} needs a nonempty string id`);
    }
    if (index.has(node.id)) throw new TypeError(`duplicate node id ${node.id}`);
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) {
      throw new TypeError(`node ${node.id} has invalid coordinates`);
    }
    index.set(node.id, i);
    return { id: node.id, x: node.x, y: node.y };
  });

  const normEdges = edges.map((edge, i) => {
    if (!edge || typeof edge !== 'object') throw new TypeError(`edge ${i} must be an object`);
    const { a, b } = edge;
    if (!index.has(a) || !index.has(b)) {
      throw new TypeError(`edge ${i} references an unknown node (${String(a)} to ${String(b)})`);
    }
    const length = edge.length === undefined
      ? Math.hypot(normNodes[index.get(a)].x - normNodes[index.get(b)].x, normNodes[index.get(a)].y - normNodes[index.get(b)].y)
      : edge.length;
    if (!Number.isFinite(length) || length < 0) throw new TypeError(`edge ${i} has an invalid length`);
    const gradePct = edge.gradePct ?? 0;
    if (!Number.isFinite(gradePct) || gradePct < 0) throw new TypeError(`edge ${i} has an invalid gradePct`);
    const shadePct = edge.shadePct ?? 0;
    if (!Number.isFinite(shadePct) || shadePct < 0 || shadePct > 100) {
      throw new TypeError(`edge ${i} shadePct must be within 0 to 100`);
    }
    const curbRamps = edge.curbRamps ?? true;
    if (typeof curbRamps !== 'boolean') throw new TypeError(`edge ${i} curbRamps must be a boolean`);
    const surface = edge.surface ?? 'paved';
    if (!Object.prototype.hasOwnProperty.call(SURFACE_FACTORS, surface)) {
      throw new TypeError(`edge ${i} has an unknown surface "${String(surface)}"`);
    }
    return {
      a, b, aIdx: index.get(a), bIdx: index.get(b), index: i,
      name: edge.name ?? `${a}-${b}`, length, gradePct, shadePct, curbRamps, surface,
    };
  });

  const adjacency = Array.from({ length: normNodes.length }, () => []);
  for (const edge of normEdges) {
    adjacency[edge.aIdx].push({ to: edge.bIdx, edge });
    adjacency[edge.bIdx].push({ to: edge.aIdx, edge });
  }
  // Deterministic scan order: neighbors are visited by node index, so equal
  // cost candidates resolve the same way on every run.
  for (const list of adjacency) list.sort((x, y) => x.to - y.to);

  return { nodes: normNodes, edges: normEdges, index, adjacency };
}

function resolveProfile(options) {
  const base = ACCESS_PROFILES[options.profile ?? 'pedestrian'];
  if (!base) throw new TypeError(`unknown routing profile "${String(options.profile)}"`);
  const weights = { ...base.weights };
  for (const [key, value] of Object.entries(options.weights ?? {})) {
    if (!(key in weights)) throw new TypeError(`unknown weight "${key}"`);
    if (!Number.isFinite(value) || value < 0) throw new TypeError(`weight ${key} must be a nonnegative finite number`);
    weights[key] = value;
  }
  const hard = { ...base.hard, ...(options.hard ?? {}) };
  if (!(hard.maxGradePct > 0)) throw new TypeError('hard.maxGradePct must be positive');
  if (typeof hard.requireCurbRamps !== 'boolean') throw new TypeError('hard.requireCurbRamps must be a boolean');
  if (typeof hard.allowStairs !== 'boolean') throw new TypeError('hard.allowStairs must be a boolean');
  return { id: base.id, label: base.label, weights, hard };
}

/** Weighted multi-objective cost of one edge under a weight vector. */
export function edgeCost(edge, weights) {
  const roughness = SURFACE_FACTORS[edge.surface] - 1;
  const shadeDeficit = 1 - edge.shadePct / 100;
  return (
    edge.length * (
      weights.distance
      + weights.grade * (edge.gradePct / 10)
      + weights.shade * shadeDeficit
      + weights.surface * roughness
    )
    + weights.curb * (edge.curbRamps ? 0 : CURB_PENALTY_UNITS)
  );
}

/** Hard-constraint violations of one edge under a profile. Empty means usable. */
export function edgeBlockedReasons(edge, hard) {
  const reasons = [];
  if (!(edge.gradePct <= hard.maxGradePct + 1e-9)) reasons.push('grade-exceeds-limit');
  if (hard.requireCurbRamps && !edge.curbRamps) reasons.push('missing-curb-ramp');
  if (!hard.allowStairs && edge.surface === 'stairs') reasons.push('stairs-not-allowed');
  return reasons;
}

// ---------------------------------------------------------------------------
// Binary min-heap keyed on (cost, insertion order): deterministic pops.
// ---------------------------------------------------------------------------
function heapPush(heap, item) {
  heap.push(item);
  let i = heap.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    const a = heap[i];
    const b = heap[parent];
    if (a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])) {
      heap[i] = b;
      heap[parent] = a;
      i = parent;
    } else break;
  }
}
function heapPop(heap) {
  const top = heap[0];
  const last = heap.pop();
  if (heap.length) {
    heap[0] = last;
    let i = 0;
    for (;;) {
      const left = i * 2 + 1;
      const right = left + 1;
      let smallest = i;
      for (const k of [left, right]) {
        if (k < heap.length) {
          const a = heap[k];
          const b = heap[smallest];
          if (a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])) smallest = k;
        }
      }
      if (smallest === i) break;
      const tmp = heap[i];
      heap[i] = heap[smallest];
      heap[smallest] = tmp;
      i = smallest;
    }
  }
  return top;
}

/**
 * Dijkstra over usable edges. Nonnegative costs only, so the first pop of the
 * target is optimal. Ties keep the predecessor reached first in (cost,
 * insertion) order, which is deterministic for a fixed normalized graph.
 */
function dijkstra(graph, source, target, usable, weights) {
  const n = graph.nodes.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prevNode = new Int32Array(n).fill(-1);
  const prevEdge = new Int32Array(n).fill(-1);
  const heap = [];
  let seq = 0;
  dist[source] = 0;
  heapPush(heap, [0, seq, source]);
  seq += 1;
  let expanded = 0;
  while (heap.length) {
    const [cost, , u] = heapPop(heap);
    if (cost > dist[u]) continue;
    expanded += 1;
    if (u === target) break;
    for (const { to, edge } of graph.adjacency[u]) {
      if (!usable(edge)) continue;
      const nd = cost + edgeCost(edge, weights);
      // Strict comparison: any numerically shorter path wins, and only an
      // exact === tie keeps the predecessor found first in insertion order.
      if (nd < dist[to]) {
        dist[to] = nd;
        prevNode[to] = u;
        prevEdge[to] = edge.index;
        heapPush(heap, [nd, seq, to]);
        seq += 1;
      }
    }
  }
  const found = Number.isFinite(dist[target]);
  const path = [];
  const edgeIndices = [];
  if (found) {
    let cursor = target;
    while (cursor !== source) {
      path.push(cursor);
      edgeIndices.push(prevEdge[cursor]);
      cursor = prevNode[cursor];
      if (cursor < 0) break;
    }
    path.push(source);
    path.reverse();
    edgeIndices.reverse();
  }
  return { found, path, edgeIndices, cost: dist[target], expanded };
}

/** BFS reachability under an edge predicate, for unreachable diagnostics. */
function reachableSet(graph, source, usable) {
  const seen = new Uint8Array(graph.nodes.length);
  seen[source] = 1;
  const stack = [source];
  while (stack.length) {
    const u = stack.pop();
    for (const { to, edge } of graph.adjacency[u]) {
      if (seen[to] || !usable(edge)) continue;
      seen[to] = 1;
      stack.push(to);
    }
  }
  return seen;
}

function countBits(bits) {
  let total = 0;
  for (const bit of bits) total += bit;
  return total;
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}

function zeroBreakdown() {
  return { distance: 0, gradePenalty: 0, shadePenalty: 0, surfacePenalty: 0, curbPenalty: 0 };
}

function unreachableResult(graph, source, target, profile, strictUsable) {
  const strictReach = reachableSet(graph, source, strictUsable);
  const looseReach = reachableSet(graph, source, () => true);
  const blocked = { grade: 0, curb: 0, stairs: 0 };
  for (const edge of graph.edges) {
    if (!(edge.gradePct <= profile.hard.maxGradePct + 1e-9)) blocked.grade += 1;
    if (profile.hard.requireCurbRamps && !edge.curbRamps) blocked.curb += 1;
    if (!profile.hard.allowStairs && edge.surface === 'stairs') blocked.stairs += 1;
  }
  let nearest = null;
  let best = Infinity;
  for (let i = 0; i < graph.nodes.length; i += 1) {
    if (!looseReach[i]) continue;
    const d = Math.hypot(graph.nodes[i].x - graph.nodes[target].x, graph.nodes[i].y - graph.nodes[target].y);
    if (d < best - 1e-9) {
      best = d;
      nearest = graph.nodes[i].id;
    }
  }
  return {
    status: 'unreachable',
    profile: profile.id,
    path: [],
    edges: [],
    cost: Infinity,
    totalLength: 0,
    breakdown: zeroBreakdown(),
    violations: [],
    relaxedConstraints: [],
    diagnostics: {
      strictReachableNodes: countBits(strictReach),
      relaxedReachableNodes: countBits(looseReach),
      totalNodes: graph.nodes.length,
      blockedEdges: blocked,
      nearestReachableToTarget: nearest === null ? null : { id: nearest, straightLineUnits: round4(best) },
      hint: nearest === null
        ? 'The source has no outgoing usable edges.'
        : `Closest reachable node is ${nearest}, ${round4(best)} units straight-line from the target.`,
    },
  };
}

/**
 * Find the best path across an attributed street graph under a profile.
 *
 * @param {object} graphInput raw graph (see normalizeGraph)
 * @param {string} fromId source node id
 * @param {string} toId target node id
 * @param {object} [options]
 * @param {string} [options.profile='pedestrian'] key of ACCESS_PROFILES
 * @param {object} [options.weights] per-key overrides merged onto the profile
 * @param {object} [options.hard] per-key overrides for hard constraints
 * @returns {object} result with status 'optimal', 'relaxed', 'unreachable' or
 *   'trivial', plus path, per-edge detail, cost breakdown, violations and
 *   diagnostics. Deterministic for identical inputs.
 */
export function findAccessibleRoute(graphInput, fromId, toId, options = {}) {
  const graph = normalizeGraph(graphInput);
  const profile = resolveProfile(options);
  const source = graph.index.get(fromId);
  const target = graph.index.get(toId);
  if (source === undefined) throw new TypeError(`unknown source node "${String(fromId)}"`);
  if (target === undefined) throw new TypeError(`unknown target node "${String(toId)}"`);

  if (source === target) {
    return {
      status: 'trivial',
      profile: profile.id,
      path: [fromId],
      edges: [],
      cost: 0,
      totalLength: 0,
      breakdown: zeroBreakdown(),
      violations: [],
      relaxedConstraints: [],
      diagnostics: { nodesExpanded: 0, nodeCount: graph.nodes.length, edgeCount: graph.edges.length },
    };
  }

  const usableFor = (hard) => (edge) => edgeBlockedReasons(edge, hard).length === 0;
  const strictUsable = usableFor(profile.hard);
  let result = dijkstra(graph, source, target, strictUsable, profile.weights);
  const relaxedConstraints = [];

  if (!result.found) {
    // Deterministic relaxation ladder: lift the grade limit first, then the
    // curb-ramp requirement, then the stair ban. Each level keeps every
    // earlier relaxation applied, and the first connecting level wins.
    const ladder = [];
    if (Number.isFinite(profile.hard.maxGradePct)) {
      ladder.push({
        key: 'max-grade-pct',
        apply: (hard) => { hard.maxGradePct = Infinity; },
      });
    }
    if (profile.hard.requireCurbRamps) {
      ladder.push({ key: 'curb-ramps', apply: (hard) => { hard.requireCurbRamps = false; } });
    }
    if (!profile.hard.allowStairs) {
      ladder.push({ key: 'stairs', apply: (hard) => { hard.allowStairs = true; } });
    }
    const relaxedHard = { ...profile.hard };
    for (const step of ladder) {
      step.apply(relaxedHard);
      relaxedConstraints.push(step.key);
      result = dijkstra(graph, source, target, usableFor(relaxedHard), profile.weights);
      if (result.found) break;
    }
  }

  if (!result.found) return unreachableResult(graph, source, target, profile, strictUsable);

  const pathEdges = result.edgeIndices.map((i) => graph.edges[i]);
  const breakdown = zeroBreakdown();
  for (const edge of pathEdges) {
    breakdown.distance += edge.length * profile.weights.distance;
    breakdown.gradePenalty += edge.length * profile.weights.grade * (edge.gradePct / 10);
    breakdown.shadePenalty += edge.length * profile.weights.shade * (1 - edge.shadePct / 100);
    breakdown.surfacePenalty += edge.length * profile.weights.surface * (SURFACE_FACTORS[edge.surface] - 1);
    breakdown.curbPenalty += profile.weights.curb * (edge.curbRamps ? 0 : CURB_PENALTY_UNITS);
  }
  const violations = pathEdges
    .map((edge, i) => ({ edgeIndex: i, name: edge.name, a: edge.a, b: edge.b, reasons: edgeBlockedReasons(edge, profile.hard) }))
    .filter((entry) => entry.reasons.length > 0);

  return {
    status: relaxedConstraints.length ? 'relaxed' : 'optimal',
    profile: profile.id,
    path: result.path.map((i) => graph.nodes[i].id),
    edges: pathEdges.map((edge) => ({
      name: edge.name,
      a: edge.a,
      b: edge.b,
      length: round4(edge.length),
      gradePct: edge.gradePct,
      shadePct: edge.shadePct,
      curbRamps: edge.curbRamps,
      surface: edge.surface,
      cost: round4(edgeCost(edge, profile.weights)),
      violations: edgeBlockedReasons(edge, profile.hard),
    })),
    cost: round4(result.cost),
    totalLength: round4(pathEdges.reduce((sum, edge) => sum + edge.length, 0)),
    breakdown: {
      distance: round4(breakdown.distance),
      gradePenalty: round4(breakdown.gradePenalty),
      shadePenalty: round4(breakdown.shadePenalty),
      surfacePenalty: round4(breakdown.surfacePenalty),
      curbPenalty: round4(breakdown.curbPenalty),
    },
    violations,
    relaxedConstraints,
    diagnostics: {
      nodesExpanded: result.expanded,
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
    },
  };
}

/**
 * Deterministic synthetic demo network used by the in-app lab and the tests.
 * One street block with a steep connector, a stair shortcut, a crossing with
 * no curb ramp, a shaded corridor and a detached island component for the
 * unreachable diagnostic.
 */
export function accessDemoGraph() {
  return {
    nodes: [
      { id: 'A', x: 0, y: 0 },
      { id: 'B', x: 4, y: 0 },
      { id: 'C', x: 8, y: 0 },
      { id: 'D', x: 0, y: 4 },
      { id: 'E', x: 4, y: 4 },
      { id: 'F', x: 8, y: 4 },
      { id: 'G', x: 4, y: 8 },
      { id: 'H', x: 20, y: 20 },
      { id: 'I', x: 24, y: 20 },
    ],
    edges: [
      { a: 'A', b: 'B', gradePct: 2, shadePct: 10, name: 'Ash St' },
      { a: 'B', b: 'C', gradePct: 15, shadePct: 5, name: 'Baker Hill' },
      { a: 'C', b: 'F', gradePct: 3, shadePct: 10, name: 'Cedar Ave' },
      { a: 'F', b: 'G', gradePct: 2, shadePct: 70, name: 'Fig Lane' },
      { a: 'A', b: 'D', gradePct: 1, shadePct: 85, name: 'Oak Row' },
      { a: 'D', b: 'E', gradePct: 2, shadePct: 90, name: 'Elm Walk' },
      { a: 'E', b: 'F', gradePct: 14, shadePct: 80, name: 'Pine Rise' },
      { a: 'E', b: 'G', gradePct: 4, shadePct: 30, curbRamps: false, name: 'Quince Crossing' },
      { a: 'A', b: 'E', gradePct: 3, shadePct: 40, surface: 'stairs', name: 'Rush Stairs' },
      { a: 'B', b: 'E', gradePct: 9.5, shadePct: 55, name: 'Spruce Cut' },
      { a: 'H', b: 'I', gradePct: 0, shadePct: 50, name: 'Island Lane' },
    ],
  };
}

export default {
  ACCESS_PROFILES, SURFACE_FACTORS, CURB_PENALTY_UNITS,
  normalizeGraph, findAccessibleRoute, accessDemoGraph, listAccessProfiles,
  edgeCost, edgeBlockedReasons,
};
