/**
 * Seeded, deterministic neighborhood scenarios and a weather surge injector.
 *
 * All randomness comes from a Mulberry32 PRNG with an explicit integer seed.
 * There are no calls to Math.random() and no wall-clock reads, so every
 * scenario and every surge is byte-for-byte reproducible in tests and in the
 * browser. Coordinates use a simple street grid plus small deterministic
 * jitter for Euclidean routing.
 */

export const SKILLS = Object.freeze({
  BILINGUAL: 'bilingual',
  HEAVY_LIFT: 'heavy-lift',
  TUTORING: 'tutoring',
  MEDICAL_PICKUP: 'medical-pickup',
});

/** Mulberry32 deterministic PRNG. Returns a function producing [0, 1) floats. */
export function mulberry32(seedInput) {
  const seed = seedInput >>> 0;
  let a = seed;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function jitter(rng, scale) {
  return (rng() - 0.5) * scale;
}

function gridPoint(rng, col, row, spacing = 2) {
  return {
    x: Math.round((col * spacing + jitter(rng, 0.5)) * 100) / 100,
    y: Math.round((row * spacing + jitter(rng, 0.5)) * 100) / 100,
  };
}

function makeVolunteer(rng, id, name, skills, mode, capacity, col, row) {
  return {
    id,
    name,
    skills,
    mode,
    capacity,
    home: gridPoint(rng, col, row),
  };
}

function makeRequest(rng, id, description, x, y, opts = {}) {
  return {
    id,
    description,
    location: gridPoint(rng, x, y),
    skillRequired: opts.skillRequired ?? null,
    load: opts.load ?? 1,
    urgency: opts.urgency ?? 3,
    readyAt: opts.readyAt ?? 0,
    deadline: opts.deadline ?? 480,
    windowMinutes: opts.windowMinutes ?? 120,
    createdAt: opts.createdAt ?? 0,
  };
}

/** Oakwood Mutual Aid Groceries preset. */
function oakwood() {
  const rng = mulberry32(0x0a11f00d);
  const volunteers = [
    makeVolunteer(rng, 'v-oak-1', 'Maya', [SKILLS.HEAVY_LIFT], 'car', 6, 0, 0),
    makeVolunteer(rng, 'v-oak-2', 'Theo', [], 'bike', 4, 5, 1),
    makeVolunteer(rng, 'v-oak-3', 'Iris', [SKILLS.BILINGUAL], 'walk', 3, 2, 5),
    makeVolunteer(rng, 'v-oak-4', 'Noor', [SKILLS.HEAVY_LIFT], 'car', 5, 7, 4),
  ];
  const requests = [
    makeRequest(rng, 'r-oak-1', 'Grocery crate, east block', 3, 2, { load: 3, urgency: 4, deadline: 180 }),
    makeRequest(rng, 'r-oak-2', 'Pharmacy pickup', 6, 3, { skillRequired: SKILLS.MEDICAL_PICKUP, urgency: 5, deadline: 120 }),
    makeRequest(rng, 'r-oak-3', 'Pantry restock', 1, 4, { load: 2, urgency: 3, deadline: 240 }),
    makeRequest(rng, 'r-oak-4', 'Bulk water delivery', 8, 2, { load: 4, skillRequired: SKILLS.HEAVY_LIFT, urgency: 4 }),
    makeRequest(rng, 'r-oak-5', 'Spanish interpretation at intake', 2, 6, { skillRequired: SKILLS.BILINGUAL, urgency: 5, deadline: 90 }),
    makeRequest(rng, 'r-oak-6', 'Warm meal drop', 4, 7, { urgency: 2, deadline: 300 }),
    makeRequest(rng, 'r-oak-7', 'Diaper supply run', 7, 6, { load: 2, urgency: 4, deadline: 200 }),
    makeRequest(rng, 'r-oak-8', 'Library book return', 5, 5, { urgency: 1, deadline: 420 }),
  ];
  return {
    id: 'oakwood-groceries',
    name: 'Oakwood Mutual Aid Groceries',
    description: 'A residential grid where neighbors share grocery, pharmacy and supply runs.',
    grid: { columns: 9, rows: 8, spacing: 2 },
    volunteers,
    requests,
    seed: 0x0a11f00d,
  };
}

/** Student After-School Tutoring Pod preset. */
function tutoringPod() {
  const rng = mulberry32(0x7a7000);
  const volunteers = [
    makeVolunteer(rng, 'v-tut-1', 'Ada', [SKILLS.TUTORING, SKILLS.BILINGUAL], 'walk', 4, 1, 1),
    makeVolunteer(rng, 'v-tut-2', 'Ben', [SKILLS.TUTORING], 'bike', 5, 4, 0),
    makeVolunteer(rng, 'v-tut-3', 'Cleo', [SKILLS.TUTORING], 'walk', 3, 6, 3),
    makeVolunteer(rng, 'v-tut-4', 'Dev', [], 'car', 6, 2, 6),
  ];
  const requests = [
    makeRequest(rng, 'r-tut-1', 'Algebra session, grade 9', 2, 2, { skillRequired: SKILLS.TUTORING, urgency: 4, deadline: 150 }),
    makeRequest(rng, 'r-tut-2', 'Reading support, bilingual', 5, 1, { skillRequired: SKILLS.BILINGUAL, urgency: 3, deadline: 210 }),
    makeRequest(rng, 'r-tut-3', 'Homework drop off', 7, 2, { urgency: 2, deadline: 300 }),
    makeRequest(rng, 'r-tut-4', 'Science lab kit pickup', 3, 4, { load: 2, urgency: 4, deadline: 180 }),
    makeRequest(rng, 'r-tut-5', 'Evening math review', 6, 5, { skillRequired: SKILLS.TUTORING, urgency: 5, deadline: 120 }),
    makeRequest(rng, 'r-tut-6', 'Essay feedback', 1, 5, { skillRequired: SKILLS.TUTORING, urgency: 3 }),
    makeRequest(rng, 'r-tut-7', 'Snack box delivery', 4, 6, { load: 1, urgency: 1, deadline: 360 }),
  ];
  return {
    id: 'tutoring-pod',
    name: 'Student After-School Tutoring Pod',
    description: 'Students and volunteers trade tutoring, supplies and rides across a school district grid.',
    grid: { columns: 8, rows: 7, spacing: 2 },
    volunteers,
    requests,
    seed: 0x7a7000,
  };
}

/** Winter Freeze Senior Check-In preset. */
function winterFreeze() {
  const rng = mulberry32(0xf2ee7e);
  const volunteers = [
    makeVolunteer(rng, 'v-wnt-1', 'Faye', [SKILLS.MEDICAL_PICKUP], 'car', 8, 0, 2),
    makeVolunteer(rng, 'v-wnt-2', 'Gus', [], 'bike', 5, 4, 1),
    makeVolunteer(rng, 'v-wnt-3', 'Hana', [SKILLS.BILINGUAL], 'walk', 4, 2, 6),
    makeVolunteer(rng, 'v-wnt-4', 'Omar', [SKILLS.HEAVY_LIFT], 'car', 6, 6, 5),
    makeVolunteer(rng, 'v-wnt-5', 'Lena', [], 'walk', 3, 8, 2),
  ];
  const requests = [
    makeRequest(rng, 'r-wnt-1', 'Welfare check, north flats', 1, 0, { urgency: 5, deadline: 90 }),
    makeRequest(rng, 'r-wnt-2', 'Medication refill', 3, 3, { skillRequired: SKILLS.MEDICAL_PICKUP, urgency: 5, deadline: 120 }),
    makeRequest(rng, 'r-wnt-3', 'Firewood bundle', 7, 1, { load: 5, skillRequired: SKILLS.HEAVY_LIFT, urgency: 4 }),
    makeRequest(rng, 'r-wnt-4', 'Hot soup run', 5, 4, { load: 2, urgency: 3, deadline: 180 }),
    makeRequest(rng, 'r-wnt-5', 'Phone tree follow-up, Spanish', 2, 7, { skillRequired: SKILLS.BILINGUAL, urgency: 4, deadline: 150 }),
    makeRequest(rng, 'r-wnt-6', 'Blanket drop', 8, 6, { load: 3, urgency: 4, deadline: 210 }),
    makeRequest(rng, 'r-wnt-7', 'Pet feed check', 6, 7, { urgency: 2, deadline: 300 }),
    makeRequest(rng, 'r-wnt-8', 'Shoveled walkway', 4, 2, { load: 2, urgency: 3, deadline: 240 }),
    makeRequest(rng, 'r-wnt-9', 'Grocery delivery, south lane', 1, 4, { load: 2, urgency: 3, deadline: 270 }),
  ];
  return {
    id: 'winter-freeze',
    name: 'Winter Freeze Senior Check-In',
    description: 'Urgent wellness checks and supply runs during a cold snap across a compact town grid.',
    grid: { columns: 9, rows: 8, spacing: 2 },
    volunteers,
    requests,
    seed: 0xf2ee7e,
  };
}

/** Immutable registry of the three built-in scenarios. */
export const SCENARIOS = Object.freeze({
  oakwood: oakwood(),
  tutoring: tutoringPod(),
  winter: winterFreeze(),
});

/** Return scenario ids in insertion order. */
export function listScenarioIds() {
  return Object.keys(SCENARIOS);
}

/** Deep clone a scenario so callers may mutate it safely. */
export function cloneScenario(scenario) {
  return JSON.parse(JSON.stringify(scenario));
}

/**
 * Inject deterministic urgent weather-surge check-ins.
 *
 * @param {object} scenario a scenario object (not mutated)
 * @param {number} seed integer PRNG seed
 * @param {number} count number of urgent requests to add
 * @returns {object} a new scenario with added requests and `surge` metadata
 */
export function injectSurge(scenario, seed, count) {
  if (!scenario || !Array.isArray(scenario.requests)) throw new TypeError('scenario must contain requests');
  if (!Number.isFinite(seed)) throw new TypeError('seed must be a finite integer');
  const amount = Math.max(0, Math.floor(count));
  const rng = mulberry32(seed);
  const next = cloneScenario(scenario);
  const columns = next.grid?.columns ?? 9;
  const rows = next.grid?.rows ?? 8;
  const tags = ['Weather surge welfare check', 'Storm supply drop', 'Icy path assistance', 'Heat check'];
  for (let i = 0; i < amount; i += 1) {
    const col = Math.floor(rng() * columns);
    const row = Math.floor(rng() * rows);
    const tag = tags[Math.floor(rng() * tags.length)];
    next.requests.push(
      makeRequest(rng, `${next.id}-surge-${seed}-${i}`, `${tag} ${i + 1}`, col, row, {
        urgency: 5,
        load: 1 + Math.floor(rng() * 3),
        deadline: 60 + Math.floor(rng() * 90),
        windowMinutes: 60,
        createdAt: 0,
      }),
    );
  }
  next.surge = { seed, count: amount, injectedAt: 'deterministic' };
  return next;
}

export default { SCENARIOS, SKILLS, mulberry32, injectSurge, cloneScenario, listScenarioIds };
