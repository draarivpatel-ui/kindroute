/**
 * UI, offline-hygiene and interaction-contract tests for the KindRoute app.
 * These tests run in Node with no browser: they verify the shipped markup,
 * stylesheets, service worker and video choreography contract, plus the
 * engine-backed numbers and hash-security behavior the UI depends on.
 * Run with: node --test tests/*.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SCENARIOS, injectSurge, cloneScenario } from '../src/scenarios.js';
import { runDispatch } from '../src/dispatch.js';
import { encryptCard, decryptCard, parseShareFragment, buildShareUrl } from '../src/crypto-card.js';
import { renderQrSvg } from '../src/qr-svg.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const HTML = read('index.html');
const CSS = read('styles.css');
const APP = read('src/app.js');
const MAP = read('src/map-viz.js');
const SW = read('sw.js');

// ---------------------------------------------------------------------------
// Required UI contract: selectors used by app.js and video steps.json
// ---------------------------------------------------------------------------
const REQUIRED_IDS = [
  'main-content', 'tab-map', 'tab-algo', 'tab-card',
  'panel-map', 'panel-algo', 'panel-card',
  'scenario-list', 'scenario-oakwood', 'scenario-tutoring', 'scenario-winter',
  'surge-toggle', 'surge-note', 'request-desc', 'request-urgency', 'request-load', 'add-request',
  'capacity-volunteer', 'capacity-minus', 'capacity-plus', 'capacity-value',
  'solve-time', 'map-title', 'map-canvas', 'map-wrap', 'map-inspect',
  'map-status', 'baseline-toggle', 'reset-view', 'zoom-in', 'zoom-out',
  'savings-pct', 'km-saved', 'metric-distance', 'metric-latency', 'metric-gini',
  'metric-late', 'metric-compute', 'metric-unfulfilled', 'route-list', 'route-count',
  'hung-prev', 'hung-next', 'hung-counter', 'hung-title', 'hung-detail', 'hung-matrix',
  'swap-prev', 'swap-next', 'swap-counter', 'swap-title', 'swap-detail', 'swap-visual', 'swap-rows',
  'dispatch-empty', 'dispatch-body', 'qr-frame', 'card-name', 'card-summary',
  'card-stops', 'card-link', 'copy-link', 'tamper-test', 'tamper-result', 'print-sheet', 'volunteer-view', 'go-map',
  'volunteer-view-panel', 'vv-name', 'vv-summary', 'vv-stops', 'exit-volunteer-view',
  'print-sheet-doc', 'toast', 'offline-chip', 'offline-label',
];

test('index.html defines every selector the controller and video cues use', () => {
  for (const id of REQUIRED_IDS) {
    assert.match(HTML, new RegExp(`id="${id}"`), `missing #${id}`);
  }
  for (const scenario of ['oakwood', 'tutoring', 'winter']) {
    assert.match(HTML, new RegExp(`data-scenario="${scenario}"`));
  }
  assert.match(APP, /getElementById/);
  assert.match(HTML, /<script type="module" src="\.\/src\/app\.js"><\/script>/);
  assert.match(HTML, /<link rel="stylesheet" href="\.\/styles\.css">/);
});

test('all three preset savings and the surge figure appear as live engine numbers', () => {
  const expected = {
    oakwood: 49.35,
    tutoring: 21.342,
    winter: 33.196,
  };
  for (const [id, saved] of Object.entries(expected)) {
    assert.equal(runDispatch(SCENARIOS[id]).metrics.totalDistance.savedPercent, saved, id);
  }
  // The surge note must show the exact figure the toggle produces for the
  // active preset, not a hardcoded winter-only number. Oakwood surges to 52.228.
  const oakwoodSurge = runDispatch(injectSurge(SCENARIOS.oakwood, 4242, 5));
  assert.equal(oakwoodSurge.metrics.totalDistance.savedPercent, 52.228);
  assert.match(HTML, /52\.23% saved/);
  const winterSurge = runDispatch(injectSurge(SCENARIOS.winter, 4242, 5));
  assert.equal(winterSurge.metrics.totalDistance.savedPercent, 40.978);
  assert.match(APP, /updateSurgeNote/);
  assert.match(APP, /surgeProjection/);
  // Rounded figures shown in the scenario rail.
  assert.match(HTML, /49\.35% saved/);
  assert.match(HTML, /21\.34% saved/);
});

test('live re-solve stays under 15 ms for every preset and the surge variant', () => {
  for (const id of Object.keys(SCENARIOS)) {
    for (const scenario of [SCENARIOS[id], injectSurge(SCENARIOS[id], 4242, 5)]) {
      // Warm up JIT once, then time a single representative browser-sized solve.
      runDispatch(scenario);
      const start = performance.now();
      runDispatch(scenario);
      const elapsed = performance.now() - start;
      assert.ok(elapsed < 15, `${id} solve took ${elapsed.toFixed(2)} ms (must be < 15 ms)`);
    }
  }
});

test('add-request and capacity controls feed a valid six-phase Hungarian trace', () => {
  const scenario = cloneScenario(SCENARIOS.oakwood);
  scenario.requests.push({
    id: 'ui-added-1', description: 'Warm meal drop', location: { x: 4.2, y: 1.4 },
    load: 1, urgency: 5, deadline: 300, windowMinutes: 180,
  });
  scenario.volunteers[0].capacity = Math.min(12, scenario.volunteers[0].capacity + 1);
  const result = runDispatch(scenario);
  const types = result.matched.steps.map((s) => s.type);
  for (const phase of ['row-reduction', 'col-reduction', 'star-zeros', 'cover-cols', 'augment-path', 'final-assignment']) {
    assert.ok(types.includes(phase), `missing phase ${phase}`);
  }
  assert.ok(result.optimized.routes.length > 0);
  assert.ok(result.optimized.swapTrace.every((s) => s.delta <= 0));
});

// ---------------------------------------------------------------------------
// Encrypted-card and hash-view contract
// ---------------------------------------------------------------------------
const FIXTURE_KEY = 'A'.repeat(43);
const TEST_CARD = {
  schema: 1, volunteerId: 'v-oak-1', name: 'Maya', mode: 'car',
  scenario: 'Synthetic Oakwood model', issuedAt: 0, depot: { x: 0, y: 0 }, routeKm: 0.42,
  stops: [{ id: 'r-oak-1', description: 'Grocery crate', location: { x: 3, y: 2 }, load: 3, urgency: 4, etaMinutes: 3 }],
};

test('Preview volunteer card uses a #card fragment that decrypts with no server call', async () => {
  const sealed = await encryptCard(TEST_CARD, FIXTURE_KEY);
  const url = buildShareUrl('http://127.0.0.1:8137/kindroute/', sealed);
  const fragment = url.slice(url.indexOf('#'));
  assert.match(APP, /parseShareFragment\(hash\)/);
  assert.match(APP, /decryptCard\(parsed\.ciphertext, parsed\.key\)/);
  assert.match(APP, /history\.replaceState\(null, '', state\.sealed\.url\)/);
  assert.deepEqual(await decryptCard(...Object.values(parseShareFragment(fragment))), TEST_CARD);
});

test('malformed #card hashes are rejected cleanly without evaluating markup', async () => {
  const hostile = [
    '#card=short&k=bad',
    '#card=<img src=x onerror=alert(1)>&k=AAAA',
    '#card=' + 'A'.repeat(60) + '&k=' + 'A'.repeat(43),
    '#card=only',
    '',
  ];
  for (const fragment of hostile) {
    await assert.rejects(async () => {
      const parsed = parseShareFragment(fragment);
      await decryptCard(parsed.ciphertext, parsed.key);
    });
  }
  assert.match(APP, /vv-error/);
  assert.match(APP, /textContent =/);
});

test('app writes engine values with textContent and never injects innerHTML', () => {
  assert.doesNotMatch(APP, /innerHTML\s*=/);
  assert.doesNotMatch(MAP, /innerHTML\s*=/);
  assert.match(APP, /function setText/);
  assert.match(APP, /\.textContent = String\(text/);
});

test('QR renderer emits numeric paths with fixed escaped color constants', () => {
  const svg = renderQrSvg('http://127.0.0.1:8137/kindroute/#card=abc&k=def', { quietZone: 2, size: 128, dark: '#0f172a', light: '#ffffff' });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /shape-rendering="crispEdges"/);
  assert.doesNotMatch(svg, /<script|onerror|javascript:/i);
  const pathCount = (svg.match(/M\d+,\d+h1v1h-1z/g) ?? []).length;
  assert.ok(pathCount > 100, `expected many QR modules, got ${pathCount}`);
});

// ---------------------------------------------------------------------------
// Offline and public-repo hygiene
// ---------------------------------------------------------------------------
test('no external CDN, font, map tile or analytics URLs in shipped app files', () => {
  const files = { 'index.html': HTML, 'styles.css': CSS, 'src/app.js': APP, 'src/map-viz.js': MAP, 'sw.js': SW };
  for (const [name, source] of Object.entries(files)) {
    assert.doesNotMatch(source, /https?:\/\/(?!www\.w3\.org)/, `${name} contains an external URL`);
    assert.doesNotMatch(source, /fonts\.googleapis|tile\.openstreetmap|unpkg|jsdelivr|cdnjs|gtag|googletagmanager/i, `${name} references an external service`);
    assert.doesNotMatch(source, /@import\s+url/, `${name} imports a remote stylesheet`);
  }
  // The only absolute URL is the SVG XML namespace, which is never fetched.
  assert.doesNotMatch(CSS, /url\(/);
});

test('service worker caches relative assets only inside its own scope', () => {
  assert.match(SW, /const CACHE = 'kindroute-v2'/);
  assert.match(SW, /if \(url\.origin !== self\.location\.origin\) return;/);
  assert.match(SW, /url\.pathname\.startsWith\(SCOPE\)/);
  for (const asset of ['./index.html', './styles.css', './src/app.js', './src/map-viz.js', './sw.js']) {
    assert.ok(SW.includes(`'${asset}'`), `service worker is missing ${asset}`);
  }
  assert.doesNotMatch(SW, /google|tile|cdn|analytics/i);
});

test('repo has no em/en dashes, personal emails or fabricated pilot claims', () => {
  for (const [name, source] of Object.entries({ 'index.html': HTML, 'styles.css': CSS, 'src/app.js': APP, 'src/map-viz.js': MAP, 'sw.js': SW })) {
    assert.doesNotMatch(source, /[\u2013\u2014]/, `${name} contains a Unicode dash`);
    assert.doesNotMatch(source, /aarivpatel|gmail\.com|@gmail/i, `${name} contains a personal detail`);
  }
  assert.match(HTML, /Synthetic models only/);
  assert.match(HTML, /No real addresses or community pilots are represented/);
  assert.doesNotMatch(HTML, /we partnered with|ran a pilot program|conducted a field trial|live deployment with/i);
});

test('CSS declares daylight civic palette and responsive breakpoints at the three check sizes', () => {
  assert.match(CSS, /--paper:\s*#f6f1e8/);
  assert.match(CSS, /--emerald:\s*#0f766e/);
  assert.match(CSS, /--amber:\s*#b45309/);
  assert.match(CSS, /--terra:\s*#b4462f/);
  assert.match(CSS, /@media \(max-width: 1200px\)/);
  assert.match(CSS, /@media \(max-width: 600px\)/);
  assert.doesNotMatch(CSS, /#2d1b4e|#6b21a8|#4c1d95/i, 'generic dark purple found');
  assert.match(CSS, /\.tabular\s*\{[^}]*font-variant-numeric:\s*tabular-nums/);
});

// ---------------------------------------------------------------------------
// Video choreography contract
// ---------------------------------------------------------------------------
test('video narration and steps exist with a 95 to 115 second cue budget', () => {
  assert.ok(existsSync(join(ROOT, 'video/narration.txt')), 'video/narration.txt missing');
  assert.ok(existsSync(join(ROOT, 'video/steps.json')), 'video/steps.json missing');
  const narration = read('video/narration.txt').trim();
  const words = narration.split(/\s+/).length;
  assert.ok(words >= 220 && words <= 260, `narration has ${words} words`);
  const steps = JSON.parse(read('video/steps.json'));
  assert.ok(Array.isArray(steps) && steps.length > 10);
  const times = steps.filter((s) => s.do === 'at').map((s) => s.s);
  assert.ok(times.length > 0);
  assert.ok(Math.max(...times) <= 115, `last cue at ${Math.max(...times)} s exceeds 115 s`);
  assert.ok(Math.max(...times) >= 95, `last cue at ${Math.max(...times)} s is under 95 s`);
  const allowed = new Set(['at', 'wait', 'scrollTo', 'scrollBy', 'move', 'click', 'slide', 'type', 'select', 'key', 'eval']);
  for (const step of steps) assert.ok(allowed.has(step.do), `unknown cue ${step.do}`);
});

test('every video cue targets an element that exists in the page', () => {
  const steps = JSON.parse(read('video/steps.json'));
  for (const step of steps) {
    if (!step.selector) continue;
    assert.match(step.selector, /^#/, `cue selector must be an id: ${step.selector}`);
    const id = step.selector.slice(1);
    assert.match(HTML, new RegExp(`id="${id}"`), `cue targets missing #${id}`);
  }
});

test('mobile grid guards, inline favicon, and in-place scenario mutations stay intact', () => {
  assert.match(CSS, /@media \(max-width: 860px\)\s*\{[\s\S]*?\.algo-layout,\s*\.card-panel-layout\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\);/);
  assert.match(HTML, /<link\s+rel="icon"\s+href="data:image\/svg\+xml,/);
  const appSource = read('src/app.js');
  assert.match(appSource, /function solve\(\{\s*announce = false,\s*resetScenario = false\s*\} = \{\}\)/);
  assert.match(appSource, /if \(resetScenario \|\| !state\.scenario\)/);
});
