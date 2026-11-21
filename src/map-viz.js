/**
 * Offline vector neighborhood map. Canvas 2D only: no tiles, no CDN, no fonts.
 * Renders a street grid, volunteer depots, urgency-coded request pins,
 * optimized routes (solid, colored) and an optional FCFS baseline (dashed).
 * Hover and click inspection expose stop-by-stop ETAs, distance, skill match
 * and load capacity. Wheel or button zoom and drag pan let a judge read dense
 * clusters; the view anchors on the cursor. All coordinates are synthetic grid
 * units (1 unit = 50 m).
 */

const PALETTE = Object.freeze({
  paper: '#f3eee3',
  block: '#eae3d5',
  street: '#d7cfbd',
  streetMajor: '#c9bfaa',
  ink: '#16221f',
  inkSoft: '#5b6a63',
  emerald: '#0f766e',
  amber: '#b45309',
  terra: '#b4462f',
  slate: '#475569',
  fcfs: '#64748b',
  white: '#fffdf8',
});
const ROUTE_COLORS = ['#0f766e', '#b45309', '#b4462f', '#3b6ea5', '#6d4aa8', '#7a5c1e'];
const URGENCY_COLORS = { 5: '#b4462f', 4: '#c2662c', 3: '#b45309', 2: '#5d7b45', 1: '#475569' };

const ZOOM_MIN = 1;
const ZOOM_MAX = 8;

/**
 * Pure world-extent computation shared by rendering and tests. Streets span
 * (columns - 1) * spacing grid units; request and depot coordinates already
 * live in that same unit space (they are NOT multiplied by spacing again),
 * so the world box is the union of the street extent and every point.
 */
export function computeBounds(grid, points) {
  const spacing = grid?.spacing ?? 2;
  const streetMaxX = Math.max(0, (grid?.columns ?? 9) - 1) * spacing;
  const streetMaxY = Math.max(0, (grid?.rows ?? 8) - 1) * spacing;
  let maxX = streetMaxX;
  let maxY = streetMaxY;
  for (const point of points ?? []) {
    if (Number.isFinite(point?.x) && point.x > maxX) maxX = point.x;
    if (Number.isFinite(point?.y) && point.y > maxY) maxY = point.y;
  }
  return { maxX: maxX || 1, maxY: maxY || 1 };
}

/** Shortest distance from point (px, py) to segment (x1, y1)-(x2, y2). */
export function pointSegmentDistance(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** Rounded rectangle helper (path only, no fill). */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/**
 * Create a map controller bound to a canvas element.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {object} callbacks
 * @param {(hit:object|null)=>void} callbacks.onInspect called on hover/click with hit details
 */
export function createMapViz(canvas, callbacks = {}) {
  const ctx = canvas.getContext('2d');
  let state = null;
  let hoverKey = null;
  let selectedKey = null;
  let showBaseline = false;
  let animationFrame = 0;
  let rafId = 0;
  let hits = [];
  let routeHits = [];
  let cssWidth = 0;
  let cssHeight = 0;
  // View transform: zoom k anchored on the canvas center plus a pan offset.
  let view = { k: 1, tx: 0, ty: 0 };
  let panPointer = null;
  let panStart = null;
  let dragDist = 0;
  const pointers = new Map();
  let pinch = null;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    cssWidth = Math.max(1, rect.width);
    cssHeight = Math.max(1, rect.height);
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    clampPan();
    draw();
  }

  /** @param {{scenario:object, dispatch:object}} next */
  function setState(next) {
    state = next;
    hoverKey = null;
    selectedKey = null;
    hits = [];
    draw();
  }

  function setBaseline(visible) {
    showBaseline = Boolean(visible);
    draw();
  }

  function bounds() {
    const grid = state?.scenario?.grid;
    const points = [
      ...(state?.scenario?.requests ?? []).map((r) => r.location),
      ...(state?.scenario?.volunteers ?? []).map((v) => v.home),
    ];
    return computeBounds(grid, points);
  }

  function transform() {
    const { maxX, maxY } = bounds();
    const pad = { left: 38, right: 30, top: 24, bottom: 34 };
    const base = Math.min(
      (cssWidth - pad.left - pad.right) / maxX,
      (cssHeight - pad.top - pad.bottom) / maxY,
    );
    const s = base * view.k;
    const ox = pad.left + (cssWidth - pad.left - pad.right - base * maxX) / 2;
    const oy = pad.top + (cssHeight - pad.top - pad.bottom - base * maxY) / 2;
    const cx = cssWidth / 2;
    const cy = cssHeight / 2;
    return {
      s,
      ox,
      oy,
      px: (x) => (ox + x * base - cx) * view.k + cx + view.tx,
      py: (y) => (oy + y * base - cy) * view.k + cy + view.ty,
    };
  }

  function clampPan() {
    const slack = view.k > 1 ? 24 : 0;
    const mx = Math.max(0, (view.k - 1) * cssWidth / 2) + slack;
    const my = Math.max(0, (view.k - 1) * cssHeight / 2) + slack;
    view.tx = Math.max(-mx, Math.min(mx, view.tx));
    view.ty = Math.max(-my, Math.min(my, view.ty));
  }

  /** Set an absolute zoom level anchored at canvas-local coordinates (cx, cy). */
  function zoomTo(k2, cx, cy) {
    const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, k2));
    if (clamped === view.k || !cssWidth) return;
    const bx = (cx - cssWidth / 2 - view.tx) / view.k;
    const by = (cy - cssHeight / 2 - view.ty) / view.k;
    view.tx = cx - cssWidth / 2 - bx * clamped;
    view.ty = cy - cssHeight / 2 - by * clamped;
    view.k = clamped;
    clampPan();
    draw();
  }

  /** Zoom by a factor anchored at canvas-local coordinates (cx, cy). */
  function zoomAt(factor, cx, cy) {
    zoomTo(view.k * factor, cx, cy);
  }

  function zoomBy(factor) {
    zoomAt(factor, cssWidth / 2, cssHeight / 2);
  }

  function resetView() {
    view = { k: 1, tx: 0, ty: 0 };
    hoverKey = null;
    selectedKey = null;
    draw();
  }

  /** Pan by canvas-pixel deltas, clamped like a drag pan. Used by arrow keys. */
  function panBy(dx, dy) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    view.tx += dx;
    view.ty += dy;
    clampPan();
    draw();
  }

  function requestById(id) {
    return (state?.scenario?.requests ?? []).find((r) => r.id === id) ?? null;
  }
  function volunteerById(id) {
    return (state?.scenario?.volunteers ?? []).find((v) => v.id === id) ?? null;
  }
  function routeForVolunteer(id) {
    return (state?.dispatch?.optimized?.routes ?? []).find((r) => r.volunteerId === id) ?? null;
  }

  function drawArrow(x1, y1, x2, y2, color, width, phase) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const margin = 9;
    const ax = x1 + ux * margin;
    const ay = y1 + uy * margin;
    const bx = x2 - ux * margin;
    const by = y2 - uy * margin;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
    // Animated travelling chevron.
    const t = ((phase % 100) / 100) * Math.max(0, len - margin * 2);
    const cx = ax + ux * t;
    const cy = ay + uy * t;
    const size = 5;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(cx + ux * size, cy + uy * size);
    ctx.lineTo(cx - ux * size * 0.4 - uy * size * 0.7, cy - uy * size * 0.4 + ux * size * 0.7);
    ctx.lineTo(cx - ux * size * 0.4 + uy * size * 0.7, cy - uy * size * 0.4 - ux * size * 0.7);
    ctx.closePath();
    ctx.fill();
  }

  function drawRoute(route, color, dashed, phase) {
    if (!route?.depot) return;
    const t = transform();
    const points = route.requestIds.map((id) => {
      const request = requestById(id);
      return request ? { x: t.px(request.location.x), y: t.py(request.location.y) } : null;
    });
    if (points.some((p) => p === null)) return;
    const valid = points;
    const dx = t.px(route.depot.x);
    const dy = t.py(route.depot.y);
    const routeKey = `route:${route.volunteerId}`;
    const selected = selectedKey === routeKey || hoverKey === routeKey
      || selectedKey === `volunteer:${route.volunteerId}`;
    ctx.save();
    if (dashed) ctx.setLineDash([6, 6]);
    ctx.globalAlpha = dashed ? 0.62 : (selected ? 1 : 0.88);
    ctx.lineWidth = dashed ? 2 : (selected ? 4.5 : 3);
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(dx, dy);
    valid.forEach((p) => ctx.lineTo(p.x, p.y));
    ctx.lineTo(dx, dy);
    ctx.stroke();
    ctx.restore();
    if (!dashed) {
      const nodes = [dx, dy, ...valid.flatMap((p) => [p.x, p.y]), dx, dy];
      const segments = [];
      for (let i = 0; i + 3 < nodes.length; i += 4) {
        drawArrow(nodes[i], nodes[i + 1], nodes[i + 2], nodes[i + 3], color, selected ? 3.4 : 2.4, phase + i * 9);
        segments.push({ x1: nodes[i], y1: nodes[i + 1], x2: nodes[i + 2], y2: nodes[i + 3] });
      }
      // The full closed polyline is a hit target, so a judge can select a
      // route by clicking any leg, not only the depot square.
      routeHits.push({ key: routeKey, type: 'route', id: route.volunteerId, segments, r: 9 });
    }
  }

  function draw() {
    if (!ctx || !cssWidth) return;
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    ctx.fillStyle = PALETTE.paper;
    ctx.fillRect(0, 0, cssWidth, cssHeight);
    if (!state) return;
    const t = transform();
    const grid = state.scenario?.grid ?? { columns: 9, rows: 8, spacing: 2 };
    const step = grid.spacing ?? 2;
    const { maxX, maxY } = computeBounds(grid, []);
    const px = t.px;
    const py = t.py;

    // Soft neighborhood blocks between streets.
    for (let gx = 0; gx < maxX; gx += step) {
      for (let gy = 0; gy < maxY; gy += step) {
        ctx.fillStyle = (gx / step + gy / step) % 3 === 0 ? '#ebe4d6' : '#f0eadd';
        roundRect(ctx, px(gx) + 5, py(gy) + 5, step * t.s - 10, step * t.s - 10, 4);
        ctx.fill();
      }
    }
    // Street center lines.
    ctx.lineWidth = 1;
    for (let gx = 0; gx <= maxX; gx += step) {
      ctx.strokeStyle = gx === 0 ? PALETTE.streetMajor : PALETTE.street;
      ctx.beginPath(); ctx.moveTo(px(gx), py(0) - 8); ctx.lineTo(px(gx), py(maxY) + 8); ctx.stroke();
    }
    for (let gy = 0; gy <= maxY; gy += step) {
      ctx.strokeStyle = gy === 0 ? PALETTE.streetMajor : PALETTE.street;
      ctx.beginPath(); ctx.moveTo(px(0) - 8, py(gy)); ctx.lineTo(px(maxX) + 8, py(gy)); ctx.stroke();
    }

    // Baseline dashed routes underneath.
    if (showBaseline) {
      (state.dispatch?.baseline?.routes ?? []).forEach((route) => {
        drawRoute(route, PALETTE.fcfs, true, 0);
      });
    }

    // Optimized solid routes.
    routeHits = [];
    (state.dispatch?.optimized?.routes ?? []).forEach((route, i) => {
      drawRoute(route, ROUTE_COLORS[i % ROUTE_COLORS.length], false, animationFrame);
    });

    // Point hits (depots, pins) are evaluated before route legs, so a click
    // dead-center on a stop picks the pin, while any point along a leg picks
    // the route.
    hits = [];

    // Volunteer depots (rounded squares).
    (state.scenario?.volunteers ?? []).forEach((volunteer) => {
      const x = px(volunteer.home.x);
      const y = py(volunteer.home.y);
      const key = `volunteer:${volunteer.id}`;
      const active = selectedKey === key || hoverKey === key;
      ctx.save();
      ctx.shadowColor = 'rgba(20,30,26,.2)';
      ctx.shadowBlur = active ? 10 : 4;
      ctx.fillStyle = PALETTE.emerald;
      roundRect(ctx, x - 9, y - 9, 18, 18, 4);
      ctx.fill();
      ctx.restore();
      ctx.fillStyle = PALETTE.white;
      ctx.font = '700 10px ui-monospace, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String((volunteer.name ?? '?').charAt(0)).toUpperCase(), x, y + 0.5);
      ctx.fillStyle = active ? PALETTE.ink : PALETTE.inkSoft;
      ctx.font = '600 10px -apple-system, Segoe UI, sans-serif';
      // Keep depot names inside the canvas even when the depot hugs an edge.
      const labelX = Math.max(26, Math.min(cssWidth - 26, x));
      ctx.fillText(volunteer.name ?? volunteer.id, labelX, y - 17);
      hits.push({ key, x, y, r: 13, type: 'volunteer', id: volunteer.id });
    });

    // Request pins (circles coded by urgency).
    (state.scenario?.requests ?? []).forEach((request) => {
      const x = px(request.location.x);
      const y = py(request.location.y);
      const key = `request:${request.id}`;
      const active = selectedKey === key || hoverKey === key;
      const served = Boolean((state.dispatch?.matched?.matches ?? []).find((m) => m.requestId === request.id));
      const color = URGENCY_COLORS[request.urgency] ?? PALETTE.slate;
      ctx.save();
      ctx.shadowColor = 'rgba(20,30,26,.22)';
      ctx.shadowBlur = active ? 11 : 3;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, active ? 9 : 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      if (!served) {
        ctx.strokeStyle = PALETTE.terra;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, y, 12, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.fillStyle = PALETTE.white;
      ctx.font = '700 9px ui-monospace, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(request.urgency), x, y + 0.5);
      hits.push({ key, x, y, r: 11, type: 'request', id: request.id });
    });

    hits.push(...routeHits);
  }

  function hitAt(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    // Point hits first: a click within a pin's or depot's radius aimed at that
    // marker, even where a route leg ends exactly on it.
    let best = null;
    let bestDist = Infinity;
    for (const hit of hits) {
      if (hit.type === 'route') continue;
      const d = Math.hypot(hit.x - x, hit.y - y);
      if (d <= hit.r && d < bestDist) { best = hit; bestDist = d; }
    }
    if (best) return best;
    for (const hit of hits) {
      if (hit.type !== 'route') continue;
      const d = Math.min(...hit.segments.map((s) => pointSegmentDistance(x, y, s.x1, s.y1, s.x2, s.y2)));
      if (d <= hit.r && d < bestDist) { best = hit; bestDist = d; }
    }
    return best;
  }

  /** Stop list rows shared by the volunteer and route inspectors. */
  function stopRows(route) {
    return (route?.legs ?? []).map((leg, i) => {
      const request = requestById(leg.requestId);
      const late = Number.isFinite(request?.deadline) && leg.arrivalMinutes > request.deadline;
      const lateText = late ? ` (late +${Math.round(leg.arrivalMinutes - request.deadline)} min)` : '';
      const skillText = request?.skillRequired ? ` (${request.skillRequired})` : '';
      return [`Stop ${i + 1}`, `${i + 1}. ${leg.requestId} at ${leg.arrivalMinutes} min${lateText}${skillText}`];
    });
  }

  function describe(hit) {
    if (!hit || !state) return null;
    if (hit.type === 'route') {
      const volunteer = volunteerById(hit.id);
      const route = routeForVolunteer(hit.id);
      if (!volunteer || !route) return null;
      const stops = stopRows(route);
      const lateCount = (route.legs ?? []).filter((leg) => {
        const request = requestById(leg.requestId);
        return Number.isFinite(request?.deadline) && leg.arrivalMinutes > request.deadline;
      }).length;
      return {
        title: `${volunteer.name ?? volunteer.id} - ${route.mode} route`,
        meta: `${route.requestIds.length} stop${route.requestIds.length === 1 ? '' : 's'} / ${(route.distance * 0.05).toFixed(2)} km closed loop / load ${route.load}`,
        rows: [
          ['Travel time', `${route.travelMinutes} min`],
          ['Deadline audit', lateCount === 0 ? 'every stop on time' : `${lateCount} stop${lateCount === 1 ? '' : 's'} past deadline`],
          ...stops,
        ],
        key: hit.key,
        volunteerId: volunteer.id,
      };
    }
    if (hit.type === 'request') {
      const request = requestById(hit.id);
      if (!request) return null;
      const match = (state.dispatch?.matched?.matches ?? []).find((m) => m.requestId === hit.id) ?? null;
      const route = match ? routeForVolunteer(match.volunteerId) : null;
      const leg = route?.legs?.find((l) => l.requestId === hit.id) ?? null;
      return {
        title: request.description,
        meta: `Urgency ${request.urgency}/5 / Load ${request.load ?? 1} / ${request.skillRequired ? `Skill: ${request.skillRequired}` : 'No skill required'}`,
        rows: [
          ['Status', match ? `Assigned to ${match.volunteerId}` : 'Unfulfilled'],
          ['Skill match', request.skillRequired ? (match && (match.volunteer.skills ?? []).includes(request.skillRequired) ? 'Yes' : 'No') : 'Not required'],
          ['ETA', leg ? `${leg.arrivalMinutes} min` : '--'],
          ['Distance from home', match ? `${Math.hypot(match.volunteer.home.x - request.location.x, match.volunteer.home.y - request.location.y).toFixed(2)} units (${(Math.hypot(match.volunteer.home.x - request.location.x, match.volunteer.home.y - request.location.y) * 50).toFixed(0)} m)` : '--'],
        ],
        key: hit.key,
      };
    }
    if (hit.type === 'volunteer') {
      const volunteer = volunteerById(hit.id);
      const route = routeForVolunteer(hit.id);
      if (!volunteer) return null;
      return {
        title: `${volunteer.name} - ${volunteer.mode}`,
        meta: `Capacity ${volunteer.capacity} / Skills: ${(volunteer.skills ?? []).join(', ') || 'none'}`,
        rows: [
          ['Route load', route ? `${route.load} units` : 'No route'],
          ['Route distance', route ? `${route.distance} units (${(route.distance * 0.05).toFixed(2)} km)` : '--'],
          ['Travel time', route ? `${route.travelMinutes} min` : '--'],
          ...stopRows(route),
        ],
        key: hit.key,
        volunteerId: volunteer.id,
      };
    }
    return null;
  }

  function updateHover(event) {
    const hit = hitAt(event.clientX, event.clientY);
    const key = hit?.key ?? null;
    if (key !== hoverKey) { hoverKey = key; draw(); }
    callbacks.onHover?.(describe(hit));
    canvas.style.cursor = hit ? 'pointer' : 'grab';
  }

  function onPointerDown(event) {
    if (event.button !== 0) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    canvas.setPointerCapture(event.pointerId);
    if (pointers.size === 2) {
      // Second finger down: switch from pan to pinch zoom.
      const [a, b] = [...pointers.values()];
      pinch = {
        d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        k0: view.k,
      };
      panPointer = null;
      panStart = null;
      dragDist = 10; // suppress the click that fires when fingers lift
      return;
    }
    panPointer = event.pointerId;
    panStart = { x: event.clientX, y: event.clientY, tx: view.tx, ty: view.ty };
    dragDist = 0;
    canvas.style.cursor = 'grabbing';
  }

  function onPointerMove(event) {
    if (pointers.has(event.pointerId)) {
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const rect = canvas.getBoundingClientRect();
      const cx = (a.x + b.x) / 2 - rect.left;
      const cy = (a.y + b.y) / 2 - rect.top;
      zoomTo(pinch.k0 * (d / pinch.d0), cx, cy);
      dragDist = 10;
      return;
    }
    if (panPointer === event.pointerId && panStart) {
      const dx = event.clientX - panStart.x;
      const dy = event.clientY - panStart.y;
      dragDist = Math.max(dragDist, Math.hypot(dx, dy));
      view.tx = panStart.tx + dx;
      view.ty = panStart.ty + dy;
      clampPan();
      draw();
      return;
    }
    updateHover(event);
  }

  function endPan(event) {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = null;
    if (panPointer !== event.pointerId) return;
    panPointer = null;
    panStart = null;
    canvas.style.cursor = 'grab';
  }

  function onClick(event) {
    if (dragDist > 6) { dragDist = 0; return; } // this was a pan, not a pick
    const hit = hitAt(event.clientX, event.clientY);
    selectedKey = hit?.key ?? null;
    draw();
    callbacks.onSelect?.(describe(hit), hit);
  }

  function onWheel(event) {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
    zoomAt(factor, event.clientX - rect.left, event.clientY - rect.top);
  }

  function tick(time) {
    if (!document.hidden) {
      animationFrame = (time / 70) % 100;
      draw();
    }
    rafId = requestAnimationFrame(tick);
  }

  function start() {
    if (!rafId) rafId = requestAnimationFrame(tick);
  }
  function stop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', endPan);
  canvas.addEventListener('pointercancel', endPan);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('mouseleave', () => { hoverKey = null; draw(); callbacks.onHover?.(null); });
  canvas.addEventListener('click', onClick);
  window.addEventListener('resize', resize);

  return {
    setState, setBaseline, resize, start, stop, describe, zoomBy, resetView, panBy,
    getView: () => ({ ...view }),
    getSelected: () => selectedKey,
    selectKey: (key) => { selectedKey = key; draw(); },
    describeKey: (key) => {
      const [type, ...rest] = String(key ?? '').split(':');
      return describe({ type, id: rest.join(':'), key });
    },
    getHits: () => hits.map((hit) => ({ ...hit })),
  };
}

export default { createMapViz, PALETTE, ROUTE_COLORS, computeBounds, pointSegmentDistance };
