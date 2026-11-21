/**
 * Dispatch orchestration: cost-matrix construction, constrained Hungarian
 * matching, route optimization and honest metrics, all deterministic.
 *
 * The cost for assigning a volunteer slot to a request is the sum of:
 *   - travel distance (home to request),
 *   - urgency penalty (high urgency is cheap, so it gets assigned first),
 *   - skill mismatch penalty (or a hard block when strictSkills is true),
 *   - time-window penalty (when the request deadline cannot be met).
 */

import { hungarian, expandSlots } from './hungarian.js';
import { optimizeRoutes, baselineDispatch, compareDispatch, distance, TRAVEL_MODES } from './routing.js';

const URGENCY_WEIGHT = 6;
const SKILL_MISMATCH_PENALTY = 40;
const WINDOW_PENALTY = 25;
const INFEASIBLE_COST = 1e6;

function modeConfig(volunteer) {
  const base = TRAVEL_MODES[volunteer.mode] ?? TRAVEL_MODES.walk;
  return {
    speed: Number.isFinite(volunteer.speed) && volunteer.speed > 0 ? volunteer.speed : base.speed,
    maxLoad: Number.isFinite(volunteer.maxLoad) ? volunteer.maxLoad : base.maxLoad,
    maxMinutes: Number.isFinite(volunteer.maxMinutes) ? volunteer.maxMinutes : base.maxMinutes,
  };
}

/**
 * Build an n-slots by m-requests cost matrix. Infeasible pairs (wrong skill
 * under strictSkills, load above capacity, impossible time window) receive a
 * large but finite cost so the assignment always remains well defined.
 */
export function buildCostMatrix(volunteers, requests, options = {}) {
  const slots = expandSlots(volunteers);
  const strictSkills = options.strictSkills ?? true;
  const matrix = [];
  for (const slot of slots) {
    const volunteer = slot.volunteer;
    const config = modeConfig(volunteer);
    const row = requests.map((request) => {
      const travel = distance(volunteer.home, request.location);
      const urgencyPenalty = URGENCY_WEIGHT * (6 - (request.urgency ?? 3));
      const skills = new Set(volunteer.skills ?? []);
      const skillOk = !request.skillRequired || skills.has(request.skillRequired);
      const skillPenalty = skillOk ? 0 : SKILL_MISMATCH_PENALTY;
      const load = request.load ?? 1;
      const loadOk = load <= config.maxLoad;
      const minutes = travel / config.speed;
      const windowMinutes = request.windowMinutes ?? Math.max(1, request.deadline ?? 480);
      const windowOk = minutes <= windowMinutes;
      const windowPenalty = windowOk ? 0 : WINDOW_PENALTY;
      const feasible = skillOk && loadOk && windowOk;
      return feasible
        ? travel + urgencyPenalty + skillPenalty + windowPenalty
        : INFEASIBLE_COST + travel + urgencyPenalty + skillPenalty + windowPenalty;
    });
    matrix.push(row);
  }
  return {
    matrix,
    slots,
    rowLabels: slots.map((s) => `${s.volunteerId}#${s.slotIndex}`),
    colLabels: requests.map((r) => r.id),
  };
}

/**
 * Match volunteers to requests under capacity, skill and time-window
 * constraints using the exact Hungarian solver.
 *
 * @returns {{
 *   matches: object[], unserved: object[], assignment: number[],
 *   totalCost: number, steps: object[], slots: object[], matrix: number[][]
 * }}
 */
export function matchRequests(volunteers, requests, options = {}) {
  const built = buildCostMatrix(volunteers, requests, options);
  const { matrix, slots } = built;
  const solved = hungarian(matrix, { rowLabels: built.rowLabels, colLabels: built.colLabels });
  const matches = [];
  const servedCols = new Set();
  for (let r = 0; r < solved.assignment.length; r += 1) {
    const c = solved.assignment[r];
    if (c < 0) continue;
    const rawCost = matrix[r][c];
    if (rawCost >= INFEASIBLE_COST) continue; // never serve a hard-infeasible pair
    const slot = slots[r];
    const request = requests[c];
    matches.push({
      volunteerId: slot.volunteerId,
      slotIndex: slot.slotIndex,
      requestId: request.id,
      request,
      volunteer: slot.volunteer,
      cost: rawCost,
    });
    servedCols.add(c);
  }
  const unserved = requests.filter((_, c) => !servedCols.has(c));
  return {
    matches,
    unserved,
    assignment: solved.assignment,
    totalCost: solved.totalCost,
    steps: solved.steps,
    slots,
    matrix,
  };
}

/**
 * Genuine naive FCFS baseline assignment: walk requests in input order and
 * give each to the first volunteer with remaining capacity. No cost matrix,
 * no skill matching, no savings merge, no 2-opt.
 */
export function naiveFcfsAssignments(volunteers, requests) {
  const assignments = volunteers.map((volunteer) => ({ volunteer, requests: [] }));
  const remaining = volunteers.map((v) => Math.max(0, Math.floor(v.capacity ?? 1)));
  for (const request of requests) {
    for (let i = 0; i < assignments.length; i += 1) {
      if (remaining[i] > 0) {
        assignments[i].requests.push(request);
        remaining[i] -= 1;
        break;
      }
    }
  }
  return assignments;
}

/** Group matches into the assignment shape consumed by optimizeRoutes. */
export function toAssignments(volunteers, matches) {
  return volunteers.map((volunteer) => ({
    volunteer,
    requests: matches.filter((m) => m.volunteerId === volunteer.id).map((m) => m.request),
  }));
}

/**
 * Run the complete dispatch pipeline for one scenario:
 * match, optimize routes, compute FCFS baseline and side-by-side metrics.
 */
export function runDispatch(scenario, options = {}) {
  const volunteers = scenario.volunteers ?? [];
  const requests = scenario.requests ?? [];
  const matched = matchRequests(volunteers, requests, options);
  const assignments = toAssignments(volunteers, matched.matches);
  const optimized = optimizeRoutes(assignments);
  const baselineAssignments = naiveFcfsAssignments(volunteers, requests);
  const baseline = baselineDispatch(baselineAssignments);
  const metrics = compareDispatch(optimized, baseline, { volunteers, requests });
  const routedIds = new Set(optimized.routes.flatMap((r) => r.requestIds));
  return {
    scenarioId: scenario.id,
    matched,
    assignments,
    optimized,
    baseline,
    metrics,
    unfulfilled: optimized.unfulfilled,
    unfulfilledRequests: requests.filter((r) => !routedIds.has(r.id)).length,
  };
}

export default { buildCostMatrix, matchRequests, toAssignments, runDispatch };
