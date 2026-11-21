/**
 * Deterministic route-proof export.
 *
 * Given a scenario and its dispatch result, build a self-verifiable proof
 * object: the matching summary, honest metrics, every route leg, the
 * unfulfilled diagnostics and a `checks` block that recomputes the totals a
 * reviewer would want to verify by hand. A canonical JSON form (keys sorted
 * at every depth) plus a 64-bit FNV-1a fingerprint make the export byte-for
 * byte reproducible: same scenario, same bytes, same fingerprint. There is
 * no timestamp and no randomness in the output, so a fingerprint change is
 * always a real result change.
 *
 * The CSV summary emits a metrics table, one row per routed stop and an
 * unfulfilled section. Cells that could be read as spreadsheet formulas are
 * prefixed with a single quote, and commas, quotes and newlines are escaped
 * per RFC 4180.
 */

import { TRAVEL_MODES, countLateArrivals } from './routing.js';

/** Recursively rebuild a value with object keys sorted at every depth. */
export function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep(value[key]);
    return out;
  }
  return value;
}

/** Canonical JSON: identical inputs serialize to identical strings. */
export function stableStringify(value) {
  return JSON.stringify(sortKeysDeep(value));
}

/**
 * 64-bit FNV-1a fingerprint as 16 lowercase hex chars. Integrity checksum
 * for comparison, not a cryptographic signature.
 */
export function proofFingerprint(text) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const byte of new TextEncoder().encode(String(text))) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

function roundNumber(value) {
  return Math.round(value * 1000) / 1000;
}

function maxLoadFor(volunteer, route) {
  if (volunteer && Number.isFinite(volunteer.maxLoad)) return volunteer.maxLoad;
  const mode = volunteer?.mode ?? route?.mode ?? 'walk';
  return (TRAVEL_MODES[mode] ?? TRAVEL_MODES.walk).maxLoad;
}

/**
 * Build the self-verifiable route-proof object for one dispatch run.
 *
 * @param {object} scenario scenario with volunteers, requests and grid
 * @param {object} dispatch result of runDispatch on that scenario
 * @returns {object} proof including `checks` and a `fingerprint`
 */
export function buildRouteProof(scenario, dispatch) {
  if (!scenario || typeof scenario !== 'object') throw new TypeError('scenario must be an object');
  if (!dispatch || !dispatch.optimized || !Array.isArray(dispatch.optimized.routes)) {
    throw new TypeError('dispatch must be a runDispatch result with optimized routes');
  }
  const requests = scenario.requests ?? [];
  const volunteers = new Map((scenario.volunteers ?? []).map((v) => [v.id, v]));
  const optimized = dispatch.optimized;

  const routes = optimized.routes.map((route) => ({
    volunteerId: route.volunteerId,
    mode: route.mode,
    order: route.order.slice(),
    requestIds: route.requestIds.slice(),
    legs: (route.legs ?? []).map((leg) => ({ requestId: leg.requestId, arrivalMinutes: leg.arrivalMinutes })),
    distance: route.distance,
    load: route.load,
    travelMinutes: route.travelMinutes,
    feasible: route.feasible === true,
  }));

  const unfulfilled = (optimized.unfulfilled ?? []).map((entry) => ({
    requestId: entry.request?.id ?? entry.requestId ?? null,
    volunteerId: entry.volunteerId ?? null,
    reasons: (entry.reasons ?? []).slice().sort(),
  }));

  const servedIds = new Set(routes.flatMap((route) => route.requestIds));
  const late = countLateArrivals(optimized.routes, requests);
  const recomputedDistance = roundNumber(routes.reduce((sum, route) => sum + route.distance, 0));
  const capacityViolations = routes.filter((route) => {
    const limit = maxLoadFor(volunteers.get(route.volunteerId), route);
    return route.load > limit + 1e-9;
  }).length;

  const checks = {
    routesChecked: routes.length,
    servedStops: routes.reduce((sum, route) => sum + route.requestIds.length, 0),
    declaredTotalDistance: optimized.totalDistance,
    recomputedTotalDistance: recomputedDistance,
    distanceMatches: Math.abs(recomputedDistance - optimized.totalDistance) < 0.01,
    legsMatchStops: routes.every((route) => route.legs.length === route.requestIds.length),
    allRoutesFeasible: routes.every((route) => route.feasible),
    capacityViolations,
    lateStops: late.count,
    unfulfilledReported: unfulfilled.length,
    matcher: 'hungarian exact O(n^3)',
    routing: 'clarke-wright savings + 2-opt polish',
    determinism: 'mulberry32 seeded, no wall clock',
  };

  const core = {
    schema: 1,
    tool: 'kindroute',
    synthetic: true,
    generated: 'deterministic-replay',
    scenario: {
      id: scenario.id ?? null,
      name: scenario.name ?? null,
      seed: scenario.seed ?? null,
      surge: scenario.surge ?? null,
      volunteers: (scenario.volunteers ?? []).length,
      requests: requests.length,
    },
    matching: {
      matchedPairs: dispatch.matched?.matches?.length ?? 0,
      totalCost: dispatch.matched?.totalCost ?? null,
      unroutedRequestIds: requests.filter((r) => !servedIds.has(r.id)).map((r) => r.id),
    },
    metrics: dispatch.metrics,
    routes,
    unfulfilled,
    checks,
  };
  return { ...core, fingerprint: proofFingerprint(stableStringify(core)) };
}

/**
 * Canonical pretty JSON of the route proof. Two calls on identical inputs
 * return identical strings, trailing newline included.
 */
export function routeProofJson(scenario, dispatch) {
  return `${JSON.stringify(sortKeysDeep(buildRouteProof(scenario, dispatch)), null, 2)}\n`;
}

/**
 * Escape one CSV cell. Numbers pass through raw. Text cells that begin with
 * a spreadsheet formula trigger (=, +, -, @ or tab) are prefixed with a
 * single quote; quotes are doubled and comma/quote/newline cells are quoted.
 */
export function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  let text = String(value);
  if (/^[=+\-@\t]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * Flat CSV summary of a dispatch run: a metrics table, one row per routed
 * stop with its deadline audit flag, and an unfulfilled section when any
 * request could not be routed. Deterministic for identical inputs.
 */
export function routeSummaryCsv(scenario, dispatch) {
  const proof = buildRouteProof(scenario, dispatch);
  const metrics = dispatch.metrics;
  const requests = scenario.requests ?? [];
  const deadlines = new Map(requests.map((r) => [r.id, r.deadline]));
  const loads = new Map(requests.map((r) => [r.id, r.load ?? 1]));

  const lines = [
    '# kindroute route summary',
    `# fingerprint ${proof.fingerprint}`,
    '# synthetic neighborhood model; deterministic export',
    '',
    'metric,optimized,baseline',
    `total_distance_units,${metrics.totalDistance.optimized},${metrics.totalDistance.baseline}`,
    `distance_saved_percent,${metrics.totalDistance.savedPercent},`,
    `median_response_minutes,${metrics.medianResponseLatencyMinutes.optimized},${metrics.medianResponseLatencyMinutes.baseline}`,
    `gini_workload,${metrics.gini.optimized},${metrics.gini.baseline}`,
    `late_arrivals,${metrics.lateArrivals.optimized},${metrics.lateArrivals.baseline}`,
    `unfulfilled_requests,${metrics.unfulfilledRequests.optimized},${metrics.unfulfilledRequests.baseline}`,
    `route_count,${metrics.routeCount.optimized},${metrics.routeCount.baseline}`,
    '',
    'stop,route_volunteer,mode,request_id,eta_min,deadline_min,late,load',
  ];

  for (const route of dispatch.optimized.routes) {
    (route.legs ?? []).forEach((leg, i) => {
      const deadline = deadlines.get(leg.requestId);
      const late = Number.isFinite(deadline) && leg.arrivalMinutes > deadline ? 'yes' : 'no';
      lines.push([
        i + 1,
        route.volunteerId,
        route.mode,
        leg.requestId,
        leg.arrivalMinutes,
        Number.isFinite(deadline) ? deadline : '',
        late,
        loads.get(leg.requestId) ?? '',
      ].map(csvCell).join(','));
    });
  }

  const unfulfilled = dispatch.optimized.unfulfilled ?? [];
  if (unfulfilled.length) {
    lines.push('', 'unfulfilled_request,volunteer_id,reasons');
    for (const entry of unfulfilled) {
      lines.push([
        entry.request?.id ?? entry.requestId ?? '',
        entry.volunteerId ?? '',
        (entry.reasons ?? []).slice().sort().join('|'),
      ].map(csvCell).join(','));
    }
  }
  return `${lines.join('\n')}\n`;
}

export default {
  sortKeysDeep, stableStringify, proofFingerprint,
  buildRouteProof, routeProofJson, routeSummaryCsv, csvCell,
};
