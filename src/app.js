/**
 * KindRoute browser controller. Pure ES modules, zero network, zero accounts.
 * Wires the dispatch engine, vector map, algorithm steppers and encrypted
 * volunteer cards into one offline civic-dispatch instrument.
 *
 * Security: every engine-derived value is written with textContent, never
 * innerHTML. Only the project's own QR SVG renderer produces markup, and its
 * output is derived from numeric module paths with escaped color constants.
 */
import { runDispatch, SCENARIOS, cloneScenario, injectSurge, hungarian, encryptCard, decryptCard, parseShareFragment, renderQrSvg, twoOpt } from './index.js';
import { createMapViz } from './map-viz.js';

/**
 * Illustrative teaching example: a crafted five-stop loop whose own 2-opt
 * trace contains a strictly improving swap. Used only when a live scenario is
 * already optimal, so the stepper always shows a real engine swap. This is a
 * synthetic teaching fixture, not a claim about any preset's routes.
 */
function buildDemoSwaps() {
  const points = [
    { id: 'Stop A', x: 0, y: 0 }, { id: 'Stop B', x: 10, y: 0 },
    { id: 'Stop C', x: 10, y: 10 }, { id: 'Stop D', x: 0, y: 10 },
    { id: 'Stop E', x: 5, y: 5 },
  ];
  const trace = twoOpt([0, 1, 2, 3, 4], points, { x: 5, y: -2 });
  return trace.swapTrace.map((swap) => ({
    ...swap,
    order: swap.order.map((i) => points[i].id),
    demo: true,
  }));
}

const $ = (id) => document.getElementById(id);
const state = {
  scenarioId: 'oakwood',
  activeTab: 'map',
  scenario: null,
  dispatch: null,
  surge: false,
  solveMs: 0,
  hungSteps: [],
  hungIndex: 0,
  swaps: [],
  swapIndex: 0,
  selectedVolunteerId: null,
  sealed: null,
};

let mapViz = null;
let toastTimer = 0;
let lastProcessedHash = null;

// ---------------------------------------------------------------------------
// Safe DOM helpers
// ---------------------------------------------------------------------------
function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = String(text ?? '');
}
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}
function toast(message, isError = false) {
  const node = $('toast');
  node.textContent = String(message);
  node.classList.toggle('is-error', isError);
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, isError ? 6000 : 3200);
}

// ---------------------------------------------------------------------------
// Engine solve
// ---------------------------------------------------------------------------
function activeScenario() {
  const base = cloneScenario(SCENARIOS[state.scenarioId]);
  return state.surge ? injectSurge(base, 4242, 5) : base;
}

function solve({ announce = false, resetScenario = false } = {}) {
  if (resetScenario || !state.scenario) {
    state.scenario = activeScenario();
  }
  const start = performance.now();
  state.dispatch = runDispatch(state.scenario);
  state.solveMs = Math.round((performance.now() - start) * 100) / 100;
  const matching = state.dispatch.matched;
  state.hungSteps = matching.steps ?? hungarian(matching.matrix, { rowLabels: matching.slots.map((s) => `${s.volunteerId}#${s.slotIndex}`), colLabels: state.scenario.requests.map((r) => r.id) }).steps;
  state.hungIndex = 0;
  state.swaps = state.dispatch.optimized.swapTrace ?? [];
  state.swapIsDemo = state.swaps.length === 0;
  if (state.swapIsDemo) state.swaps = buildDemoSwaps();
  state.swapIndex = 0;
  updateScenarioButtons();
  updateMap();
  updateMetrics();
  updateRoutes();
  updateStepper();
  if (state.selectedVolunteerId) sealCard(state.selectedVolunteerId, { silent: true });
  if (announce) toast(`Re-solved in ${state.solveMs} ms`);
}

function updateScenarioButtons() {
  for (const button of document.querySelectorAll('.scenario')) {
    const active = button.dataset.scenario === state.scenarioId;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  }
}

// ---------------------------------------------------------------------------
// Map + metrics + routes
// ---------------------------------------------------------------------------
function updateMap() {
  setText('map-title', state.scenario.name);
  const n = state.scenario.requests.length;
  const v = state.scenario.volunteers.length;
  setText('map-subtitle', `Synthetic neighborhood model: ${n} requests, ${v} volunteers. Click a pin or depot to inspect.`);
  mapViz?.setState({ scenario: state.scenario, dispatch: state.dispatch });
}

function showInspection(detail) {
  const box = $('map-inspect');
  if (!detail) { box.hidden = true; return; }
  box.hidden = false;
  box.replaceChildren();
  box.append(el('h3', null, detail.title));
  box.append(el('p', 'fineprint', detail.meta));
  const list = el('ul', 'inspection-list');
  for (const [label, value] of detail.rows ?? []) {
    const li = el('li');
    li.append(el('span', 'idx', label));
    li.append(el('span', null, value));
    list.append(li);
  }
  box.append(list);
}

function updateMetrics() {
  const metrics = state.dispatch.metrics;
  const saved = metrics.totalDistance.savedPercent;
  setText('savings-pct', `${saved.toFixed(2)}%`);
  const kmBase = metrics.totalDistance.baseline * 0.05;
  const kmOpt = metrics.totalDistance.optimized * 0.05;
  setText('km-saved', `${(kmBase - kmOpt).toFixed(2)} km less travel`);
  setText('metric-distance', `${kmOpt.toFixed(2)} / ${kmBase.toFixed(2)} km`);
  setText('metric-latency', `${metrics.medianResponseLatencyMinutes.optimized} / ${metrics.medianResponseLatencyMinutes.baseline} min`);
  setText('metric-gini', `${metrics.gini.optimized} / ${metrics.gini.baseline}`);
  setText('metric-compute', `${state.solveMs} ms`);
  setText('metric-unfulfilled', `${metrics.unfulfilledRequests.optimized} / ${metrics.unfulfilledRequests.baseline}`);
  setText('solve-time', `${state.solveMs} ms`);
  setText('map-status', state.dispatch.optimized.routes.length
    ? `${state.dispatch.optimized.routes.length} optimized routes, ${state.dispatch.optimized.swapTrace.length} accepted 2-opt swaps.`
    : 'No feasible routes in this synthetic model.');
}

const VOL_COLORS = ['#0f766e', '#b45309', '#b4462f', '#3b6ea5', '#6d4aa8', '#7a5c1e'];
function updateRoutes() {
  const list = $('route-list');
  list.replaceChildren();
  const routes = state.dispatch.optimized.routes;
  setText('route-count', `${routes.length} routes`);
  routes.forEach((route, i) => {
    const volunteer = state.scenario.volunteers.find((v) => v.id === route.volunteerId);
    const button = el('button', 'route-item');
    button.type = 'button';
    button.dataset.volunteer = route.volunteerId;
    button.classList.toggle('is-selected', state.selectedVolunteerId === route.volunteerId);
    const badge = el('span', 'route-badge', (volunteer?.name ?? '?').charAt(0).toUpperCase());
    badge.style.background = VOL_COLORS[i % VOL_COLORS.length];
    const name = el('span', 'route-name', volunteer?.name ?? route.volunteerId);
    const mode = el('span', 'route-mode', `${route.mode} / ${route.requestIds.length} stops`);
    const stats = el('span', 'route-stats');
    stats.append(el('span', null, `${(route.distance * 0.05).toFixed(2)} km`));
    stats.append(el('span', null, `load ${route.load}`));
    stats.append(el('span', null, `${route.travelMinutes} min`));
    button.append(badge, name, mode, stats);
    button.addEventListener('click', () => selectVolunteer(route.volunteerId));
    list.append(button);
  });
  updateCapacityOptions();
}

function updateCapacityOptions() {
  const select = $('capacity-volunteer');
  const previous = select.value;
  select.replaceChildren();
  state.scenario.volunteers.forEach((v) => {
    const option = el('option', null, `${v.name} (${v.id})`);
    option.value = v.id;
    select.append(option);
  });
  if (previous && state.scenario.volunteers.some((v) => v.id === previous)) select.value = previous;
  updateCapacityValue();
}

function updateCapacityValue() {
  const volunteer = state.scenario?.volunteers.find((v) => v.id === $('capacity-volunteer').value);
  setText('capacity-value', volunteer ? String(volunteer.capacity) : '--');
}

// ---------------------------------------------------------------------------
// Algorithm steppers
// ---------------------------------------------------------------------------
function updateStepper() {
  updateHungarian();
  updateSwaps();
}

function updateHungarian() {
  const steps = state.hungSteps;
  const total = steps.length;
  setText('hung-counter', total ? `${state.hungIndex + 1} / ${total}` : '-- / --');
  const step = steps[state.hungIndex];
  if (!step) {
    setText('hung-title', 'No trace');
    setText('hung-detail', 'No assignment trace for this model.');
    $('hung-matrix').tBodies[0].replaceChildren();
    return;
  }
  setText('hung-title', `${step.index + 1}. ${step.title ?? step.type}`);
  setText('hung-detail', step.detail ?? '');

  const matrix = step.matrix ?? state.dispatch.matched.matrix;
  const rows = matrix?.length ?? 0;
  const cols = rows ? matrix[0].length : 0;
  const rowLabels = step.rowLabels ?? state.dispatch.matched.slots.map((s) => s.volunteerId.slice(-3) + s.slotIndex);
  const colLabels = step.colLabels ?? state.scenario.requests.map((r) => r.id.slice(-3));
  const tbody = $('hung-matrix').tBodies[0];
  tbody.replaceChildren();

  const starred = new Set((step.cells ?? []).map((c) => `${c.row}:${c.col}`));
  const covered = new Set(step.coveredCols ?? []);
  const path = new Set((step.path ?? []).map((c) => `${c.row}:${c.col}`));
  const finalPairs = new Set((step.pairs ?? []).map((c) => `${c.row}:${c.col}`));

  const thead = $('hung-matrix').tHead;
  if (thead) thead.remove();
  const head = document.createElement('thead');
  const headRow = el('tr');
  headRow.append(el('th', 'rowhead', 'slot / req'));
  for (let j = 0; j < cols; j += 1) headRow.append(el('th', null, colLabels[j] ?? `c${j}`));
  head.append(headRow);
  $('hung-matrix').insertBefore(head, tbody);

  for (let i = 0; i < rows; i += 1) {
    const tr = el('tr');
    tr.append(el('th', 'rowhead', rowLabels[i] ?? `r${i}`));
    for (let j = 0; j < cols; j += 1) {
      const value = matrix[i][j];
      const cls = ['cell'];
      const reduced = Math.abs(value) < 1e-9;
      if (reduced) cls.push('zero');
      if (starred.has(`${i}:${j}`)) cls.push('star');
      if (covered.has(j)) cls.push('cover');
      if (path.has(`${i}:${j}`)) cls.push('path');
      if (finalPairs.has(`${i}:${j}`)) cls.push('match');
      const cell = el('td', cls.join(' '), Number.isFinite(value) ? (value >= 1e5 ? 'INF' : Math.round(value)) : '--');
      cell.title = `${rowLabels[i] ?? i} to ${colLabels[j] ?? j}: ${value}`;
      tr.append(cell);
    }
    tbody.append(tr);
  }
}

function updateSwaps() {
  const swaps = state.swaps;
  const total = swaps.length;
  setText('swap-counter', `${state.swapIndex} / ${total}`);
  const swap = swaps[state.swapIndex - 1];
  if (!swap) {
    setText('swap-title', total ? 'Ready to step' : 'Already optimal');
    setText('swap-detail', total
      ? `${total} strictly improving 2-opt swaps were accepted. Press Next swap to watch each one.`
      : 'No improving swap was found. The engine still records every rejected candidate in its evaluation trace.');
  } else {
    setText('swap-title', `${state.swapIsDemo ? 'Illustrative swap' : 'Swap ' + state.swapIndex}: segment ${swap.edgeA[0]}-${swap.edgeA[1]} reversed`);
    setText('swap-detail', `${state.swapIsDemo ? 'Teaching example (not a preset route). ' : ''}Closed-loop distance ${swap.beforeDist} to ${swap.afterDist} units. Exact km shaved: ${(Math.abs(swap.delta) * 0.05).toFixed(3)} km (${Math.abs(swap.delta)} grid units).`);
  }
  const visual = $('swap-visual');
  visual.replaceChildren();
  const order = swap?.order ?? state.dispatch?.optimized?.routes[0]?.requestIds ?? [];
  const before = order.slice();
  if (swap) {
    const [a, b] = swap.edgeA;
    before.splice(a, b - a + 1, ...before.slice(a, b + 1).reverse());
  }
  const after = order;
  const line = (label, nodes, hot) => {
    const row = el('div', 'order-line');
    row.append(el('span', 'order-label', label));
    nodes.forEach((node, i) => {
      if (i) row.append(el('span', 'order-arrow', '>'));
      row.append(el('span', `order-node${hot && swap && i >= swap.edgeA[0] && i <= swap.edgeA[1] ? ' hot' : ''}`, String(node).slice(-6)));
    });
    visual.append(row);
  };
  line('Before', before, false);
  line('After', after, true);
  if (swap) visual.append(el('div', 'swap-gain', `Shaved ${(Math.abs(swap.delta) * 0.05).toFixed(3)} km`));

  const rows = $('swap-rows');
  rows.replaceChildren();
  swaps.forEach((item, i) => {
    const tr = el('tr');
    tr.classList.toggle('is-active', i + 1 === state.swapIndex);
    tr.append(el('td', null, `#${i + 1} [${item.edgeA[0]},${item.edgeA[1]}]`));
    tr.append(el('td', null, item.beforeDist.toFixed(3)));
    tr.append(el('td', null, item.afterDist.toFixed(3)));
    tr.append(el('td', null, `${item.delta.toFixed(3)} u`));
    rows.append(tr);
  });
}

// ---------------------------------------------------------------------------
// Encrypted card flow
// ---------------------------------------------------------------------------
function buildCard(volunteerId) {
  const volunteer = state.scenario.volunteers.find((v) => v.id === volunteerId);
  const route = state.dispatch.optimized.routes.find((r) => r.volunteerId === volunteerId);
  if (!volunteer || !route) return null;
  const stops = route.requestIds.map((id, i) => {
    const request = state.scenario.requests.find((r) => r.id === id);
    return {
      id,
      description: request?.description ?? id,
      location: request?.location ?? { x: 0, y: 0 },
      load: request?.load ?? 1,
      urgency: request?.urgency ?? 3,
      skillRequired: request?.skillRequired ?? null,
      etaMinutes: route.legs[i]?.arrivalMinutes ?? 0,
    };
  });
  return {
    schema: 1,
    volunteerId,
    name: volunteer.name,
    mode: route.mode,
    scenario: state.scenario.name,
    issuedAt: 0,
    depot: route.depot,
    routeKm: Number((route.distance * 0.05).toFixed(3)),
    stops,
  };
}

async function sealCard(volunteerId, { silent = false } = {}) {
  const card = buildCard(volunteerId);
  if (!card) { toast('No optimized route for this volunteer.', true); return; }
  state.selectedVolunteerId = volunteerId;
  try {
    const sealed = await encryptCard(card);
    state.sealed = sealed;
    const base = `${location.origin}${location.pathname}`;
    sealed.url = `${base}${sealed.fragment}`;
    renderCard(card, sealed);
    if (!silent) {
      setText('map-status', `Sealed an encrypted card for ${card.name}. Open the Volunteer card tab to share it.`);
      toast(`Encrypted card sealed for ${card.name}`);
    }
  } catch (error) {
    toast(`Could not seal card: ${error.message}`, true);
  }
}

function renderCard(card, sealed) {
  setText('card-name', `${card.name} - ${card.mode}`);
  setText('card-summary', `${card.stops.length} stops / ${card.routeKm} km / encrypted with AES-256-GCM`);
  const qr = $('qr-frame');
  qr.replaceChildren();
  try {
    const svg = renderQrSvg(sealed.url, { ecLevel: 'L', quietZone: 3, size: 192, dark: '#0f172a', light: '#ffffff' });
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    if (doc.querySelector('parsererror')) throw new Error('QR render failed');
    qr.append(document.importNode(doc.documentElement, true));
  } catch (error) {
    toast(`QR render failed: ${error.message}`, true);
  }
  const stops = $('card-stops');
  stops.replaceChildren();
  for (const stop of card.stops) {
    const li = el('li');
    li.append(el('span', null, `${stop.description} (${stop.id})`));
    li.append(el('div', 'meta', `ETA ${stop.etaMinutes} min / load ${stop.load} / urgency ${stop.urgency}${stop.skillRequired ? ` / ${stop.skillRequired}` : ''}`));
    stops.append(li);
  }
  $('card-link').value = sealed.url;
  $('dispatch-empty').hidden = true;
  $('dispatch-body').hidden = false;
  renderPrintSheet(card, sealed);
}

function renderPrintSheet(card, sealed) {
  const doc = $('print-sheet-doc');
  doc.replaceChildren();
  doc.append(el('h1', null, `KindRoute route sheet - ${card.name}`));
  doc.append(el('p', null, `${card.scenario} / ${card.mode} / ${card.routeKm} km / synthetic neighborhood model`));
  const list = el('ol');
  for (const stop of card.stops) {
    const li = el('li');
    li.append(el('strong', null, stop.description));
    li.append(el('div', null, `${stop.id} / ETA ${stop.etaMinutes} min / load ${stop.load} / urgency ${stop.urgency}`));
    list.append(li);
  }
  doc.append(list);
  doc.append(el('p', 'fineprint', `Encrypted card link: ${sealed.url}`));
}

async function copyLink() {
  if (!state.sealed) return;
  try {
    await navigator.clipboard.writeText(state.sealed.url);
    toast('Encrypted link copied');
  } catch {
    $('card-link').select();
    toast('Select and copy the link manually');
  }
}

// ---------------------------------------------------------------------------
// Volunteer hash view
// ---------------------------------------------------------------------------
async function handleHash() {
  const hash = location.hash || '';
  if (hash === lastProcessedHash) return;
  lastProcessedHash = hash;
  const isCard = hash.startsWith('#card=');
  $('volunteer-view-panel').hidden = !isCard;
  if (isCard) {
    $('main-content').querySelectorAll('.panel').forEach((panel) => {
      panel.hidden = true;
      panel.classList.remove('is-active');
    });
    ['tab-map', 'tab-algo', 'tab-card'].forEach((id) => $(id).setAttribute('aria-selected', 'false'));
  } else {
    // Leaving the card view restores the planner on the last active tab.
    showTab(state.activeTab ?? 'map');
    return;
  }
  const list = $('vv-stops');
  list.replaceChildren();
  setText('vv-name', 'Volunteer checklist');
  setText('vv-summary', 'Decrypting locally. No request was sent.');
  try {
    const parsed = parseShareFragment(hash);
    const card = await decryptCard(parsed.ciphertext, parsed.key);
    if (!Array.isArray(card.stops)) throw new Error('card has no stop list');
    setText('vv-name', `${card.name ?? 'Volunteer'} - ${card.mode ?? 'route'}`);
    setText('vv-summary', `${card.scenario ?? 'Synthetic model'} / ${card.stops.length} stops / ${card.routeKm ?? '--'} km / decrypted in your browser`);
    card.stops.forEach((stop, i) => {
      const row = el('div', 'vv-stop');
      row.append(el('div', 'vv-num', String(i + 1)));
      row.append(el('strong', null, String(stop.description ?? stop.id ?? `Stop ${i + 1}`).slice(0, 120)));
      row.append(el('div', 'vv-meta', `${stop.id ?? ''} / load ${stop.load ?? 1} / urgency ${stop.urgency ?? 3}${stop.skillRequired ? ` / ${stop.skillRequired}` : ''}`));
      row.append(el('div', 'vv-time', `${stop.etaMinutes ?? 0} min`));
      list.append(row);
    });
  } catch (error) {
    const box = el('div', 'vv-error');
    box.textContent = `This dispatch card could not be decrypted: ${error.message}. Ask for a fresh link. Nothing was uploaded.`;
    list.append(box);
    setText('vv-summary', 'Invalid or tampered card link');
  }
}

function exitVolunteerView() {
  history.replaceState(null, '', location.pathname);
  handleHash();
  showTab('map');
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
function showTab(name) {
  state.activeTab = name;
  const ids = { map: 'panel-map', algo: 'panel-algo', card: 'panel-card' };
  for (const [tabName, panelId] of Object.entries(ids)) {
    const active = tabName === name;
    $(`tab-${tabName}`).classList.toggle('is-active', active);
    $(`tab-${tabName}`).setAttribute('aria-selected', String(active));
    $(panelId).hidden = !active;
    $(panelId).classList.toggle('is-active', active);
  }
  if (name === 'map') mapViz?.resize();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function wire() {
  for (const button of document.querySelectorAll('.scenario')) {
    button.addEventListener('click', () => {
      state.scenarioId = button.dataset.scenario;
      state.selectedVolunteerId = null;
      solve({ announce: false, resetScenario: true });
    });
  }
  $('surge-toggle').addEventListener('change', (event) => {
    state.surge = event.target.checked;
    solve({ announce: true, resetScenario: true });
  });
  $('add-request').addEventListener('click', () => {
    const description = $('request-desc').value.trim().slice(0, 48) || 'New synthetic request';
    const urgency = Math.max(1, Math.min(5, Number($('request-urgency').value) || 3));
    const load = Math.max(1, Math.min(6, Number($('request-load').value) || 1));
    const grid = state.scenario.grid ?? { columns: 9, rows: 8 };
    const seq = state.scenario.requests.length + 1;
    const location = {
      x: Math.round((1 + (seq * 1.7) % (grid.columns - 2)) * 100) / 100,
      y: Math.round((1 + (seq * 2.3) % (grid.rows - 2)) * 100) / 100,
    };
    state.scenario.requests.push({
      id: `${state.scenario.id}-added-${seq}`,
      description,
      location,
      skillRequired: null,
      load,
      urgency,
      readyAt: 0,
      deadline: 300,
      windowMinutes: 180,
      createdAt: 0,
    });
    $('request-desc').value = '';
    solve({ announce: true });
  });
  $('capacity-volunteer').addEventListener('change', updateCapacityValue);
  function adjustCapacity(delta) {
    const volunteer = state.scenario.volunteers.find((v) => v.id === $('capacity-volunteer').value);
    if (!volunteer) return;
    volunteer.capacity = Math.max(1, Math.min(12, (volunteer.capacity ?? 1) + delta));
    updateCapacityValue();
    solve({ announce: true });
  }
  $('capacity-minus').addEventListener('click', () => adjustCapacity(-1));
  $('capacity-plus').addEventListener('click', () => adjustCapacity(1));

  $('baseline-toggle').addEventListener('change', (event) => mapViz?.setBaseline(event.target.checked));
  $('reset-view').addEventListener('click', () => { showInspection(null); mapViz?.setState({ scenario: state.scenario, dispatch: state.dispatch }); });

  $('hung-prev').addEventListener('click', () => { state.hungIndex = Math.max(0, state.hungIndex - 1); updateHungarian(); });
  $('hung-next').addEventListener('click', () => { state.hungIndex = Math.min(state.hungSteps.length - 1, state.hungIndex + 1); updateHungarian(); });
  $('swap-prev').addEventListener('click', () => { state.swapIndex = Math.max(0, state.swapIndex - 1); updateSwaps(); });
  $('swap-next').addEventListener('click', () => { state.swapIndex = Math.min(state.swaps.length, state.swapIndex + 1); updateSwaps(); });

  $('go-map').addEventListener('click', () => showTab('map'));
  $('copy-link').addEventListener('click', copyLink);
  $('print-sheet').addEventListener('click', () => window.print());
  $('volunteer-view').addEventListener('click', () => {
    if (!state.sealed) { toast('Select a volunteer first', true); return; }
    history.replaceState(null, '', state.sealed.url);
    handleHash();
  });
  $('exit-volunteer-view').addEventListener('click', exitVolunteerView);

  $('tab-map').addEventListener('click', () => showTab('map'));
  $('tab-algo').addEventListener('click', () => showTab('algo'));
  $('tab-card').addEventListener('click', () => showTab('card'));
  window.addEventListener('hashchange', handleHash);
}

function selectVolunteer(volunteerId) {
  sealCard(volunteerId);
  document.querySelectorAll('.route-item').forEach((node) => {
    node.classList.toggle('is-selected', node.dataset.volunteer === volunteerId);
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function boot() {
  mapViz = createMapViz($('map-canvas'), {
    onHover: (detail) => { if (!$('map-inspect').hidden || detail) showInspection(detail); },
    onSelect: (detail, hit) => {
      showInspection(detail);
      if (hit?.volunteerId) selectVolunteer(hit.volunteerId);
    },
  });
  wire();
  solve();
  mapViz.resize();
  mapViz.start();
  const offlineChip = $('offline-chip');
  if ('serviceWorker' in navigator) {
    const markOfflineReady = () => setText('offline-label', 'Offline ready');
    if (navigator.serviceWorker.controller) markOfflineReady();
    navigator.serviceWorker.addEventListener('controllerchange', markOfflineReady);
    navigator.serviceWorker.register(new URL('../sw.js', import.meta.url), { scope: new URL('../', import.meta.url) })
      .then(markOfflineReady)
      .catch(() => {
        setText('offline-label', 'Local mode');
        offlineChip.title = 'Service worker unavailable in this context; the app still runs locally.';
      });
  } else {
    setText('offline-label', 'Local mode');
  }
  handleHash();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
