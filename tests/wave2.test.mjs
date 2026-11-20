import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { hungarian } from '../src/hungarian.js';
import { encryptCard, decryptCard, parseShareFragment } from '../src/crypto-card.js';
import { SCENARIOS, mulberry32 } from '../src/scenarios.js';
import { runDispatch } from '../src/dispatch.js';
import { pointSegmentDistance } from '../src/map-viz.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

// ---------------------------------------------------------------------------
// Hungarian trace fidelity: every displayed matrix must be a genuine reduced
// cost, reconstructible from the input and that step's dual potentials.
// ---------------------------------------------------------------------------

const MATRICES = {
  square: [[4, 1, 3], [2, 0, 5], [3, 2, 2]],
  tall: [[1, 2], [3, 4], [5, 6]],
  wide: [[10, 4, 6, 10], [8, 7, 5, 9]],
  tied: [[2, 2, 2], [2, 2, 2], [2, 2, 2]],
  zeros: [[0, 0], [0, 0]],
  mixed: [[9.5, 1.25, 7], [0.5, 3, 2.75], [4, 8.125, 1.5], [6, 2, 9]],
};

for (const [name, matrix] of Object.entries(MATRICES)) {
  test(`trace invariant: displayed matrix equals input minus dual potentials (${name})`, () => {
    const result = hungarian(matrix);
    assert.equal(result.steps.length >= 3, true);
    for (const step of result.steps) {
      const { rows, cols } = step.potentials;
      assert.equal(step.matrix.length, matrix.length, `${step.type}: row count must stay in input orientation`);
      assert.equal(step.matrix[0].length, matrix[0].length, `${step.type}: col count must stay in input orientation`);
      assert.equal(step.rowLabels.length, matrix.length);
      assert.equal(step.colLabels.length, matrix[0].length);
      for (let i = 0; i < matrix.length; i += 1) {
        for (let j = 0; j < matrix[0].length; j += 1) {
          const expected = matrix[i][j] - (rows[i] ?? 0) - (cols[j] ?? 0);
          assert.ok(
            Math.abs(step.matrix[i][j] - expected) < 1e-6,
            `${step.type} [${i}][${j}]: shown ${step.matrix[i][j]}, expected ${expected}`,
          );
        }
      }
    }
  });
}

test('trace emits all six phases in input orientation for a tall matrix', () => {
  const result = hungarian(MATRICES.tall);
  const types = new Set(result.steps.map((s) => s.type));
  for (const type of ['row-reduction', 'col-reduction', 'star-zeros', 'cover-cols', 'augment-path', 'final-assignment']) {
    assert.ok(types.has(type), `missing ${type}`);
  }
  for (const step of result.steps) {
    for (const cell of step.cells ?? []) {
      assert.ok(cell.row < 3 && cell.col < 2, 'cell must be inside input dims');
      assert.ok(cell.rowLabel.startsWith('row-') && cell.colLabel.startsWith('col-'));
    }
    for (const cell of step.path ?? []) assert.ok(cell.row < 3 && cell.col < 2);
  }
});

// Maximum bipartite matching over the zero graph, computed independently.
function maxMatchingZeros(matrix) {
  const rows = matrix.length;
  const cols = matrix[0].length;
  const matchCol = new Array(cols).fill(-1);
  const seen = new Array(cols).fill(false);
  const aug = (r) => {
    for (let c = 0; c < cols; c += 1) {
      if (matrix[r][c] !== 0 || seen[c]) continue;
      seen[c] = true;
      if (matchCol[c] === -1 || aug(matchCol[c])) { matchCol[c] = r; return true; }
    }
    return false;
  };
  let count = 0;
  for (let r = 0; r < rows; r += 1) { seen.fill(false); if (aug(r)) count += 1; }
  return count;
}

test('star-zeros is a true maximum independent zero matching', () => {
  for (const matrix of [MATRICES.square, MATRICES.tall, MATRICES.mixed]) {
    const { steps } = hungarian(matrix);
    const star = steps.find((s) => s.type === 'star-zeros');
    const usedRows = new Set();
    const usedCols = new Set();
    for (const cell of star.cells) {
      assert.equal(star.matrix[cell.row][cell.col], 0, 'starred cell must be a reduced-cost zero');
      assert.ok(!usedRows.has(cell.row) && !usedCols.has(cell.col), 'stars must be independent');
      usedRows.add(cell.row);
      usedCols.add(cell.col);
    }
    assert.equal(star.cells.length, maxMatchingZeros(star.matrix), 'stars must be a maximum matching, not a greedy pass');
  }
});

// ---------------------------------------------------------------------------
// Optimality edge cases, including the 1xN dual-seed regression caught in
// Wave 2: a naive feasible-dual start matched the first column, not the min.
// ---------------------------------------------------------------------------

function bruteForce(matrix) {
  const rows = matrix.length;
  const cols = matrix[0].length;
  let best = Infinity;
  if (rows <= cols) {
    const used = new Array(cols).fill(false);
    const walk = (r, sum) => {
      if (r === rows) { best = Math.min(best, sum); return; }
      for (let c = 0; c < cols; c += 1) {
        if (used[c]) continue;
        used[c] = true;
        walk(r + 1, sum + matrix[r][c]);
        used[c] = false;
      }
    };
    walk(0, 0);
    return best;
  }
  const usedRows = new Array(rows).fill(false);
  const walk = (c, sum) => {
    if (c === cols) { best = Math.min(best, sum); return; }
    for (let r = 0; r < rows; r += 1) {
      if (usedRows[r]) continue;
      usedRows[r] = true;
      walk(c + 1, sum + matrix[r][c]);
      usedRows[r] = false;
    }
  };
  walk(0, 0);
  return best;
}

test('1xN matrix selects the global argmin column', () => {
  const { assignment, totalCost } = hungarian([[70, 9, 50, 33, 12]]);
  assert.equal(assignment[0], 1);
  assert.equal(totalCost, 9);
});

test('Nx1, degenerate and tied matrices stay optimal', () => {
  assert.equal(hungarian([[5], [2], [9]]).totalCost, 2);
  assert.equal(hungarian([[0]]).totalCost, 0);
  assert.equal(hungarian([[7, 7], [7, 7]]).totalCost, 14);
});

test('brute-force differential on 32 seeded matrices including edges', () => {
  const cases = [
    [[70, 9, 50, 33, 12]],
    [[1], [2], [3], [4]],
    [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
    [[5, 1e6, 3], [1e6, 2, 1e6], [4, 1, 8]],
    ...Array.from({ length: 28 }, (_, k) => {
      const rand = mulberry32(9000 + k);
      const r = 1 + Math.floor(rand() * 4);
      const c = r + Math.floor(rand() * 3);
      return Array.from({ length: r }, () => Array.from({ length: c }, () => Math.floor(rand() * 90)));
    }),
  ];
  cases.forEach((matrix, i) => {
    assert.equal(hungarian(matrix).totalCost, bruteForce(matrix), `case ${i}`);
    const t = hungarian(matrix[0].map((_, j) => matrix.map((row) => row[j])));
    assert.ok(t.totalCost >= 0);
  });
});

// ---------------------------------------------------------------------------
// Polyline hit-testing: routes must be selectable along their full legs.
// ---------------------------------------------------------------------------

test('pointSegmentDistance is exact on interior, endpoint and degenerate cases', () => {
  assert.equal(pointSegmentDistance(5, 3, 0, 0, 10, 0), 3);
  assert.equal(pointSegmentDistance(0, 4, 0, 0, 10, 0), 4);
  assert.equal(pointSegmentDistance(14, 3, 0, 0, 10, 0), 5);
  assert.equal(pointSegmentDistance(3, 4, 1, 1, 1, 1), Math.hypot(2, 3));
  assert.equal(pointSegmentDistance(0, 0, 0, 0, 3, 4), 0);
});

test('dispatch routes carry real legs and swap orders index into real requests', () => {
  const dispatch = runDispatch(SCENARIOS.oakwood);
  for (const swap of dispatch.optimized.swapTrace) {
    const assignment = dispatch.assignments.find((a) => a.volunteer.id === swap.volunteerId);
    assert.ok(assignment, `swap owner ${swap.volunteerId} must have an assignment`);
    for (const idx of swap.order) {
      assert.ok(assignment.requests[idx], `order index ${idx} must map to a real request`);
    }
    assert.ok(swap.afterDist < swap.beforeDist, 'accepted swaps must strictly improve');
  }
  for (const route of dispatch.optimized.routes) {
    assert.equal(route.legs.length, route.requestIds.length);
    route.legs.forEach((leg, i) => assert.equal(leg.requestId, route.requestIds[i]));
  }
});

// ---------------------------------------------------------------------------
// AES-256-GCM edge cases: corrupted IV, tag and payload must all fail cleanly.
// ---------------------------------------------------------------------------

const CARD = {
  volunteerId: 'v-1', name: 'Maeve \u00d3 h\u00e9alaigh \ud83c\udf2e \u6771\u4eac',
  routeKm: 1.25, stops: [{ id: 'r-1', description: '\u4f9b\u6e38\u620f\u4f9b\u5e94 \u00f1and\u00fa', load: 2, etaMinutes: 12.5 }],
};

function corruptB64(b64, offset) {
  const raw = Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  raw[offset % raw.length] ^= 0x01;
  return raw.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

test('AES-GCM unicode card round-trips and every corruption fails cleanly', async () => {
  const sealed = await encryptCard(CARD);
  const back = await decryptCard(sealed.ciphertext, sealed.key);
  assert.deepEqual(back, CARD);

  const packed = Buffer.from(sealed.ciphertext.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  for (const offset of [0, 5, 11, 12, packed.length - 1, Math.floor(packed.length / 2)]) {
    await assert.rejects(() => decryptCard(corruptB64(sealed.ciphertext, offset), sealed.key), /Authentication failed|too short|Invalid card payload/);
  }
  const wrong = await encryptCard({ x: 1 });
  await assert.rejects(() => decryptCard(sealed.ciphertext, wrong.key), /Authentication failed/);
  await assert.rejects(() => decryptCard(sealed.ciphertext.slice(0, 20), sealed.key));
  await assert.rejects(() => decryptCard(sealed.ciphertext, 'AAAA'));
  assert.throws(() => parseShareFragment('#card=only'));
  assert.throws(() => parseShareFragment('#k=only'));
  await assert.rejects(() => encryptCard('not an object'), TypeError);
});

// ---------------------------------------------------------------------------
// Layout and hygiene invariants.
// ---------------------------------------------------------------------------

test('public surface has no em/en dashes, no smooth scroll, valid tab roles', () => {
  for (const rel of ['index.html', 'styles.css', 'src/app.js', 'src/map-viz.js', 'README.md']) {
    const text = read(rel);
    assert.equal(text.includes('\u2014'), false, `${rel} contains an em dash`);
    assert.equal(text.includes('\u2013'), false, `${rel} contains an en dash`);
  }
  const css = read('styles.css');
  assert.equal(/scroll-behavior\s*:\s*smooth/.test(css), false);
  const html = read('index.html');
  assert.ok(html.includes('role="tablist"'), 'tab bar must own the tablist role');
  assert.equal((html.match(/role="tab"/g) ?? []).length, 3);
  assert.ok(html.includes('Covered row or column'), 'matrix legend must describe both covered dims');
});

test('map exposes route hits and selection APIs used by the click audit', () => {
  const src = read('src/map-viz.js');
  for (const needle of ['routeHits.push', "type: 'route'", 'selectKey', 'describeKey', 'getHits', 'pointSegmentDistance', 'pinch']) {
    assert.ok(src.includes(needle), `map-viz.js missing ${needle}`);
  }
});
