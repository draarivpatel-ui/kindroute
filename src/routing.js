/**
 * Capacitated multi-stop loop optimization.
 *
 * Clarke-Wright savings merging builds a set of feasible routes from assigned
 * requests and a volunteer home depot. 2-Opt edge swaps then polish each
 * route. Every accepted swap is recorded in `swapTrace` so a UI can animate
 * exactly which edges changed and by how much. A naive FCFS baseline provides
 * honest side-by-side metrics: distance saved, unfulfilled requests, median
 * response latency and Gini workload fairness.
 *
 * Distances are Euclidean grid units (one unit is 50 meters). Speeds are
 * grid units per minute: walk 1.6, bike 4.8, car 12. Loads/time budgets are
 * per mode defaults, overridable on each volunteer.
 */

// One grid unit represents 50 meters. Speeds are grid units per minute:
// walk 80 m/min, bike 240 m/min, car 600 m/min.
export const TRAVEL_MODES = Object.freeze({
  walk: Object.freeze({ speed: 1.6, maxLoad: 6, maxMinutes: 180, label: 'Walk' }),
  bike: Object.freeze({ speed: 4.8, maxLoad: 12, maxMinutes: 150, label: 'Bike' }),
  car: Object.freeze({ speed: 12, maxLoad: 40, maxMinutes: 240, label: 'Car' }),
});

/** Euclidean distance between two {x, y} points. */
export function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Distance from a volunteer home to a request, round-trip (closed loop). */
export function roundTrip(home, point) {
  return 2 * distance(home, point);
}

function modeConfig(volunteer) {
  const base = TRAVEL_MODES[volunteer.mode] ?? TRAVEL_MODES.walk;
  return {
    speed: Number.isFinite(volunteer.speed) && volunteer.speed > 0 ? volunteer.speed : base.speed,
    maxLoad: Number.isFinite(volunteer.maxLoad) ? volunteer.maxLoad : base.maxLoad,
    maxMinutes: Number.isFinite(volunteer.maxMinutes) ? volunteer.maxMinutes : base.maxMinutes,
  };
}

function routeDistance(order, points) {
  if (order.length === 0) return 0;
  let total = 0;
  for (let k = 0; k < order.length - 1; k += 1) {
    total += distance(points[order[k]], points[order[k + 1]]);
  }
  return total;
}

function closedDistance(order, points, depot) {
  if (order.length === 0) return 0;
  let total = distance(depot, points[order[0]]);
  for (let k = 0; k < order.length - 1; k += 1) {
    total += distance(points[order[k]], points[order[k + 1]]);
  }
  total += distance(points[order[order.length - 1]], depot);
  return total;
}

/** Per-request arrival minutes from the depot along a route's stop order. */
function routeLegs(order, points, depot, speed) {
  const legs = [];
  let previous = depot;
  let elapsed = 0;
  for (const idx of order) {
    elapsed += distance(previous, points[idx]) / speed;
    legs.push({ requestId: points[idx].id, arrivalMinutes: roundNumber(elapsed) });
    previous = points[idx];
  }
  return legs;
}

/** Normalize a request into a routing point with top-level x/y coordinates. */
function toPoint(request) {
  if (!request || typeof request !== 'object') throw new TypeError('request must be an object');
  const source = request.location && typeof request.location === 'object' ? request.location : request;
  const x = Number.isFinite(source.x) ? source.x : request.x;
  const y = Number.isFinite(source.y) ? source.y : request.y;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new TypeError(`request ${request.id ?? '(unnamed)'} has invalid coordinates`);
  }
  return { ...request, x, y };
}

function routeLoad(order, points) {
  return order.reduce((sum, idx) => sum + (points[idx].load ?? 1), 0);
}

function routeFeasible(order, points, config) {
  if (order.length === 0) return false;
  if (routeLoad(order, points) > config.maxLoad + 1e-9) return false;
  const dist = routeDistance(order, points);
  const latest = Math.max(...order.map((idx) => points[idx].deadline ?? Number.POSITIVE_INFINITY));
  const earliest = Math.min(...order.map((idx) => points[idx].readyAt ?? 0));
  const timeBudget = Math.min(config.maxMinutes, latest - earliest);
  return dist / config.speed <= timeBudget + 1e-9;
}

/**
 * Two-opt local search on a closed loop. Only strictly improving swaps are
 * accepted, so the route distance is monotonically non-increasing.
 *
 * @returns {{order:number[], distance:number, swapTrace:object[], evaluations:object[]}}
 *   `swapTrace` holds accepted, strictly improving swaps only.
 *   `evaluations` holds every candidate edge pair the stepper considered.
 */
export function twoOpt(orderInput, points, depot) {
  let order = orderInput.slice();
  let best = closedDistance(order, points, depot);
  const swapTrace = [];
  const evaluations = [];
  if (order.length < 4) return { order, distance: best, swapTrace, evaluations };

  let improved = true;
  let guard = 0;
  const maxIterations = Math.max(100, order.length * order.length * 10);
  while (improved && guard < maxIterations) {
    improved = false;
    let bestDelta = -1e-9;
    let bestI = -1;
    let bestJ = -1;
    for (let i = 0; i < order.length - 2; i += 1) {
      for (let j = i + 2; j < order.length; j += 1) {
        if (i === 0 && j === order.length - 1) continue;
        const a = i === 0 ? depot : points[order[i - 1]];
        const b = points[order[i]];
        const c = points[order[j]];
        const d = j + 1 === order.length ? depot : points[order[j + 1]];
        const beforeEdgeA = distance(a, b);
        const beforeEdgeB = distance(c, d);
        const afterEdgeA = distance(a, c);
        const afterEdgeB = distance(b, d);
        const delta = afterEdgeA + afterEdgeB - beforeEdgeA - beforeEdgeB;
        if (evaluations.length < 200) {
          evaluations.push({
            edgeA: [i, j],
            edgeB: [i, j],
            beforeDist: roundNumber(beforeEdgeA + beforeEdgeB),
            afterDist: roundNumber(afterEdgeA + afterEdgeB),
            delta: roundNumber(delta),
            accepted: false,
          });
        }
        if (delta < bestDelta) {
          bestDelta = delta;
          bestI = i;
          bestJ = j;
        }
      }
    }
    if (bestI >= 0) {
      const next = order.slice(0, bestI).concat(order.slice(bestI, bestJ + 1).reverse(), order.slice(bestJ + 1));
      const nextDistance = closedDistance(next, points, depot);
      swapTrace.push({
        beforeDist: roundNumber(best),
        afterDist: roundNumber(nextDistance),
        delta: roundNumber(nextDistance - best),
        edgeA: [bestI, bestJ],
        edgeB: [bestI, bestJ],
        reversedSegment: [bestI, bestJ],
        order: next.slice(),
      });
      const match = evaluations.find((e) => e.edgeA[0] === bestI && e.edgeA[1] === bestJ);
      if (match) match.accepted = true;
      order = next;
      best = nextDistance;
      improved = true;
    }
    guard += 1;
  }
  return { order, distance: best, swapTrace, evaluations };
}

/**
 * Build optimized closed loops for a set of assignments.
 *
 * @param {object[]} assignments each: { volunteer, requests: object[] }
 * @returns {{
 *   routes: object[], totalDistance: number, swapTrace: object[],
 *   savingsSteps: object[], unfulfilled: object[]
 * }}
 */
export function optimizeRoutes(assignments) {
  if (!Array.isArray(assignments)) throw new TypeError('assignments must be an array');
  const routes = [];
  const swapTrace = [];
  const evaluations = [];
  const savingsSteps = [];
  let stepIndex = 0;
  let unfulfilled = [];

  for (const assignment of assignments) {
    const volunteer = assignment.volunteer;
    if (!volunteer || !volunteer.home) continue;
    const config = modeConfig(volunteer);
    const points = (assignment.requests ?? []).map(toPoint);
    const depot = volunteer.home;

    // Clarke-Wright savings list: merging stops i and j saves
    // d(depot,i) + d(depot,j) - d(i,j) versus two separate loops.
    const savings = [];
    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        const saving = distance(depot, points[i]) + distance(depot, points[j]) - distance(points[i], points[j]);
        savings.push({ i, j, saving });
      }
    }
    savings.sort((a, b) => b.saving - a.saving);

    // Start with one route per stop.
    let clusters = points.map((_, idx) => [idx]);
    const merged = new Set();
    for (const item of savings) {
      if (item.saving <= 0) continue;
      let ci = -1;
      let cj = -1;
      for (let k = 0; k < clusters.length; k += 1) {
        if (clusters[k].includes(item.i)) ci = k;
        if (clusters[k].includes(item.j)) cj = k;
      }
      if (ci < 0 || cj < 0 || ci === cj) continue;
      const a = clusters[ci];
      const b = clusters[cj];
      const combined = a.concat(b);
      if (!routeFeasible(combined, points, config)) continue;
      clusters = clusters.filter((_, k) => k !== ci && k !== cj);
      clusters.push(combined);
      merged.add(`${item.i}-${item.j}`);
      savingsSteps.push({
        index: stepIndex++,
        volunteerId: volunteer.id,
        type: 'merge',
        detail: `Merged stops ${item.i} and ${item.j} for saving ${roundNumber(item.saving)}.`,
        saving: roundNumber(item.saving),
        before: [a.slice(), b.slice()],
        after: combined.slice(),
        clusters: clusters.map((c) => c.slice()),
      });
    }

    // Any stops that could not merge are still served as individual routes.
    for (const cluster of clusters) {
      if (cluster.length === 0) continue;
      const polished = twoOpt(cluster, points, depot);
      for (const swap of polished.swapTrace) {
        swapTrace.push({ ...swap, volunteerId: volunteer.id, stepIndex: swapTrace.length });
      }
      for (const evaluation of polished.evaluations) {
        evaluations.push({ ...evaluation, volunteerId: volunteer.id, stepIndex: evaluations.length });
      }
      const load = routeLoad(cluster, points);
      const travelMinutes = polished.distance / config.speed;
      routes.push({
        volunteerId: volunteer.id,
        mode: volunteer.mode ?? 'walk',
        depot,
        order: polished.order,
        requestIds: polished.order.map((idx) => points[idx].id),
        legs: routeLegs(polished.order, points, depot, config.speed),
        distance: roundNumber(polished.distance),
        load: roundNumber(load),
        travelMinutes: roundNumber(travelMinutes),
        feasible: true,
        savings: savingsSteps.filter((s) => s.volunteerId === volunteer.id).map((s) => s.saving),
      });
    }
  }

  return {
    routes,
    totalDistance: roundNumber(routes.reduce((sum, route) => sum + route.distance, 0)),
    swapTrace,
    evaluations,
    savingsSteps,
    unfulfilled,
  };
}

/**
 * Naive first-come-first-served baseline. Each request goes to the first
 * volunteer with remaining capacity, in request input order. No savings
 * merging and no 2-opt polish are applied.
 */
export function baselineDispatch(assignments) {
  if (!Array.isArray(assignments)) throw new TypeError('assignments must be an array');
  const routes = [];
  const unfulfilled = [];
  for (const assignment of assignments) {
    const volunteer = assignment.volunteer;
    if (!volunteer || !volunteer.home) continue;
    const config = modeConfig(volunteer);
    const points = (assignment.requests ?? []).map(toPoint);
    const order = points.map((_, idx) => idx);
    const load = routeLoad(order, points);
    const dist = closedDistance(order, points, volunteer.home);
    const travelMinutes = dist / config.speed;
    routes.push({
      volunteerId: volunteer.id,
      mode: volunteer.mode ?? 'walk',
      depot: volunteer.home,
      order,
      requestIds: order.map((idx) => points[idx].id),
      legs: routeLegs(order, points, volunteer.home, config.speed),
      distance: roundNumber(dist),
      load: roundNumber(load),
      travelMinutes: roundNumber(travelMinutes),
      feasible: load <= config.maxLoad + 1e-9,
    });
  }
  return { routes, totalDistance: roundNumber(routes.reduce((sum, r) => sum + r.distance, 0)), unfulfilled };
}

/** Gini coefficient of a workload vector. 0 = perfectly even, 1 = maximal inequality. */
export function gini(valuesInput) {
  const values = valuesInput.filter((v) => Number.isFinite(v)).map((v) => Math.max(0, v));
  if (values.length === 0) return 0;
  const sum = values.reduce((a, b) => a + b, 0);
  if (sum === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const n = sorted.length;
  let weighted = 0;
  for (let i = 0; i < n; i += 1) weighted += (i + 1) * sorted[i];
  const g = (2 * weighted) / (n * sum) - (n + 1) / n;
  return roundNumber(Math.max(0, Math.min(1, g)));
}

/** Median of a numeric array. Returns 0 for an empty array. */
export function median(valuesInput) {
  if (!valuesInput || valuesInput.length === 0) return 0;
  const sorted = valuesInput.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Compare optimized routes to the naive FCFS baseline.
 *
 * @param {object} optimized result of optimizeRoutes
 * @param {object} baseline result of baselineDispatch
 * @param {object} [context]
 * @param {object[]} [context.volunteers] volunteer objects for fairness math
 * @param {object[]} [context.requests] all requests, for unfulfilled counting
 */
export function compareDispatch(optimized, baseline, context = {}) {
  const baseDist = baseline.totalDistance;
  const optDist = optimized.totalDistance;
  const distanceSavedPercent = baseDist > 0 ? ((baseDist - optDist) / baseDist) * 100 : 0;

  const volunteers = context.volunteers ?? [];
  const optimizedLoads = volunteers.map((v) =>
    optimized.routes.filter((r) => r.volunteerId === v.id).reduce((sum, r) => sum + r.load, 0),
  );
  const baselineLoads = volunteers.map((v) =>
    baseline.routes.filter((r) => r.volunteerId === v.id).reduce((sum, r) => sum + r.load, 0),
  );
  const optimizedGini = gini(optimizedLoads.length ? optimizedLoads : optimized.routes.map((r) => r.load));
  const baselineGini = gini(baselineLoads.length ? baselineLoads : baseline.routes.map((r) => r.load));

  // Response latency is measured per served request: minutes from the
  // volunteer's home to that stop along the route, not per route. This keeps
  // the median stable even when route counts differ between strategies.
  const optimizedLatencies = optimized.routes.flatMap((r) => (r.legs ?? []).map((l) => l.arrivalMinutes));
  const baselineLatencies = baseline.routes.flatMap((r) => (r.legs ?? []).map((l) => l.arrivalMinutes));

  return {
    totalDistance: {
      optimized: roundNumber(optDist),
      baseline: roundNumber(baseDist),
      savedPercent: roundNumber(distanceSavedPercent),
    },
    gini: {
      optimized: optimizedGini,
      baseline: baselineGini,
      improvement: roundNumber(baselineGini - optimizedGini),
    },
    medianResponseLatencyMinutes: {
      optimized: roundNumber(median(optimizedLatencies)),
      baseline: roundNumber(median(baselineLatencies)),
    },
    unfulfilledRequests: {
      optimized: (context.requests ?? []).length - optimized.routes.reduce((sum, r) => sum + r.requestIds.length, 0),
      baseline: (context.requests ?? []).length - baseline.routes.reduce((sum, r) => sum + r.requestIds.length, 0),
    },
    routeCount: { optimized: optimized.routes.length, baseline: baseline.routes.length },
  };
}

function roundNumber(value) {
  return Math.round(value * 1000) / 1000;
}

export default { optimizeRoutes, baselineDispatch, compareDispatch, twoOpt, gini, median, TRAVEL_MODES, distance };
