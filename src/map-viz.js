/**
 * Offline vector neighborhood map. Canvas 2D only: no tiles, no CDN, no fonts.
 * Renders a street grid, volunteer depots, urgency-coded request pins,
 * optimized routes (solid, colored) and an optional FCFS baseline (dashed).
 * Hover and click inspection expose stop-by-stop ETAs, distance, skill match
 * and load capacity. All coordinates are synthetic grid units (1 unit = 50 m).
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
  let cssWidth = 0;
  let cssHeight = 0;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    cssWidth = Math.max(1, rect.width);
    cssHeight = Math.max(1, rect.height);
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
    const grid = state?.scenario?.grid ?? { columns: 9, rows: 8, spacing: 2 };
    const maxX = Math.max(grid.columns - 1, ...(state?.scenario?.requests ?? []).map((r) => r.location.x), 0) * (grid.spacing ?? 2);
    const maxY = Math.max(grid.rows - 1, ...(state?.scenario?.requests ?? []).map((r) => r.location.y), 0) * (grid.spacing ?? 2);
    return { maxX: maxX || 1, maxY: maxY || 1 };
  }

  function transform() {
    const { maxX, maxY } = bounds();
    const pad = { left: 38, right: 30, top: 24, bottom: 34 };
    const sx = (cssWidth - pad.left - pad.right) / maxX;
    const sy = (cssHeight - pad.top - pad.bottom) / maxY;
    const s = Math.min(sx, sy);
    const ox = pad.left + (cssWidth - pad.left - pad.right - s * maxX) / 2;
    const oy = pad.top + (cssHeight - pad.top - pad.bottom - s * maxY) / 2;
    return { s, ox, oy, px: (x) => ox + x * s, py: (y) => oy + y * s };
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
    const selected = selectedKey === `route:${route.volunteerId}` || hoverKey === `route:${route.volunteerId}`;
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
      for (let i = 0; i + 3 < nodes.length; i += 4) {
        drawArrow(nodes[i], nodes[i + 1], nodes[i + 2], nodes[i + 3], color, selected ? 3.4 : 2.4, phase + i * 9);
      }
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
    const maxX = Math.max(grid.columns - 1, 0) * step;
    const maxY = Math.max(grid.rows - 1, 0) * step;

    // Soft neighborhood blocks between streets.
    for (let gx = 0; gx < maxX; gx += step) {
      for (let gy = 0; gy < maxY; gy += step) {
        ctx.fillStyle = (gx / step + gy / step) % 3 === 0 ? '#ebe4d6' : '#f0eadd';
        roundRect(ctx, t.px(gx) + 5, t.py(gy) + 5, step * t.s - 10, step * t.s - 10, 4);
        ctx.fill();
      }
    }
    // Street center lines.
    ctx.lineWidth = 1;
    for (let gx = 0; gx <= maxX; gx += step) {
      ctx.strokeStyle = gx === 0 ? PALETTE.streetMajor : PALETTE.street;
      ctx.beginPath(); ctx.moveTo(t.px(gx), t.py(0) - 8); ctx.lineTo(t.px(gx), t.py(maxY) + 8); ctx.stroke();
    }
    for (let gy = 0; gy <= maxY; gy += step) {
      ctx.strokeStyle = gy === 0 ? PALETTE.streetMajor : PALETTE.street;
      ctx.beginPath(); ctx.moveTo(t.px(0) - 8, t.py(gy)); ctx.lineTo(t.px(maxX) + 8, t.py(gy)); ctx.stroke();
    }

    // Baseline dashed routes underneath.
    if (showBaseline) {
      (state.dispatch?.baseline?.routes ?? []).forEach((route) => {
        drawRoute(route, PALETTE.fcfs, true, 0);
      });
    }

    // Optimized solid routes.
    (state.dispatch?.optimized?.routes ?? []).forEach((route, i) => {
      drawRoute(route, ROUTE_COLORS[i % ROUTE_COLORS.length], false, animationFrame);
    });

    hits = [];

    // Volunteer depots (rounded squares).
    (state.scenario?.volunteers ?? []).forEach((volunteer) => {
      const x = t.px(volunteer.home.x);
      const y = t.py(volunteer.home.y);
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
      ctx.fillText(volunteer.name ?? volunteer.id, x, y - 17);
      hits.push({ key, x, y, r: 13, type: 'volunteer', id: volunteer.id });
    });

    // Request pins (circles coded by urgency).
    (state.scenario?.requests ?? []).forEach((request) => {
      const x = t.px(request.location.x);
      const y = t.py(request.location.y);
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

    // Route hit targets along segment midpoints (for route inspection).
    (state.dispatch?.optimized?.routes ?? []).forEach((route) => {
      const key = `route:${route.volunteerId}`;
      const t2 = transform();
      const x = t2.px(route.depot.x);
      const y = t2.py(route.depot.y);
      hits.push({ key, x, y, r: 0, type: 'route', id: route.volunteerId });
    });
  }

  function hitAt(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best = null;
    let bestDist = Infinity;
    for (const hit of hits) {
      if (hit.r === 0) continue;
      const d = Math.hypot(hit.x - x, hit.y - y);
      if (d <= hit.r && d < bestDist) { best = hit; bestDist = d; }
    }
    return best;
  }

  function describe(hit) {
    if (!hit || !state) return null;
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
      const stops = (route?.legs ?? []).map((leg, i) => {
        const request = requestById(leg.requestId);
        return `${i + 1}. ${leg.requestId} at ${leg.arrivalMinutes} min${request?.skillRequired ? ` (${request.skillRequired})` : ''}`;
      });
      return {
        title: `${volunteer.name} - ${volunteer.mode}`,
        meta: `Capacity ${volunteer.capacity} / Skills: ${(volunteer.skills ?? []).join(', ') || 'none'}`,
        rows: [
          ['Route load', route ? `${route.load} units` : 'No route'],
          ['Route distance', route ? `${route.distance} units (${(route.distance * 0.05).toFixed(2)} km)` : '--'],
          ['Travel time', route ? `${route.travelMinutes} min` : '--'],
          ...stops.map((s, i) => [`Stop ${i + 1}`, s]),
        ],
        key: hit.key,
        volunteerId: volunteer.id,
      };
    }
    if (hit.type === 'route') {
      const route = routeForVolunteer(hit.id);
      const volunteer = volunteerById(hit.id);
      if (!route || !volunteer) return null;
      return {
        title: `${volunteer.name}'s route`,
        meta: `${route.requestIds.length} stops / ${route.mode} / load ${route.load}`,
        rows: (route.legs ?? []).map((leg, i) => [`Stop ${i + 1}`, `${leg.requestId} at ${leg.arrivalMinutes} min`]),
        key: hit.key,
        volunteerId: volunteer.id,
      };
    }
    return null;
  }

  function onMove(event) {
    const hit = hitAt(event.clientX, event.clientY);
    const key = hit?.key ?? null;
    if (key !== hoverKey) { hoverKey = key; draw(); }
    callbacks.onHover?.(describe(hit));
    canvas.style.cursor = hit ? 'pointer' : 'default';
  }

  function onClick(event) {
    const hit = hitAt(event.clientX, event.clientY);
    selectedKey = hit?.key ?? null;
    draw();
    callbacks.onSelect?.(describe(hit), hit);
  }

  function tick(time) {
    animationFrame = (time / 70) % 100;
    draw();
    rafId = requestAnimationFrame(tick);
  }

  function start() {
    if (!rafId) rafId = requestAnimationFrame(tick);
  }
  function stop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('mouseleave', () => { hoverKey = null; draw(); callbacks.onHover?.(null); });
  canvas.addEventListener('click', onClick);
  window.addEventListener('resize', resize);

  return { setState, setBaseline, resize, start, stop, describe, getSelected: () => selectedKey };
}

export default { createMapViz, PALETTE, ROUTE_COLORS };
