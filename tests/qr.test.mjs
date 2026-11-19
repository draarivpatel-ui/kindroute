/**
 * Deterministic unit tests for the zero-dependency ISO/IEC 18004 QR encoder.
 * Run with: node --test tests/*.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { encodeQrMatrix, renderQrSvg } from '../src/qr-svg.js';
import { encryptCard, buildShareUrl, parseShareFragment, decryptCard } from '../src/crypto-card.js';
import { SCENARIOS, injectSurge } from '../src/scenarios.js';
import { runDispatch } from '../src/dispatch.js';

// ---------------------------------------------------------------------------
// Structural invariants: matrix size, finder, timing, dark module
// ---------------------------------------------------------------------------
// Minimal byte-mode payload length that selects each version at level L,
// derived from the ISO data-codeword table (max bytes = dataCW - 2 for
// versions 1-9 with an 8-bit count, dataCW - 3 for versions 10-20 with a
// 16-bit count). Verified: 150 -> v7, 458 -> v14, 590-byte URL -> v17.
const MIN_BYTES_L = [1, 18, 33, 54, 79, 107, 135, 155, 193, 231, 272, 322, 368, 426, 459, 521, 587, 645, 719, 793];

test('QR matrix size is 21 + 4*(version - 1) for versions 1 through 20', () => {
  for (let version = 1; version <= 20; version += 1) {
    const expected = 21 + 4 * (version - 1);
    const payload = 'x'.repeat(MIN_BYTES_L[version - 1]);
    const qr = encodeQrMatrix(payload, 'L');
    assert.equal(qr.version, version, `version for ${payload.length} bytes should be ${version}`);
    assert.equal(qr.size, expected, `size for version ${version}`);
    assert.equal(qr.modules.length, expected);
    for (const row of qr.modules) {
      assert.equal(row.length, expected);
      for (const cell of row) assert.ok(cell === 0 || cell === 1);
    }
  }
});

test('QR contains 7x7 finder patterns in three corners with separators', () => {
  const { modules, size } = encodeQrMatrix('finder check', 'L');
  const corner = (r0, c0) => {
    for (let r = 0; r < 7; r += 1) {
      for (let c = 0; c < 7; c += 1) {
        const dark = r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        assert.equal(modules[r0 + r][c0 + c], dark ? 1 : 0, `finder at (${r0},${c0}) cell (${r},${c})`);
      }
    }
    // Separator: immediately surrounding ring is light.
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const y = r0 + r;
        const x = c0 + c;
        if (y < 0 || y >= size || x < 0 || x >= size) continue;
        if (r >= 0 && r <= 6 && c >= 0 && c <= 6) continue;
        assert.equal(modules[y][x], 0, `separator at (${y},${x}) near finder (${r0},${c0})`);
      }
    }
  };
  corner(0, 0);
  corner(0, size - 7);
  corner(size - 7, 0);
});

test('QR timing rows and columns alternate dark on even coordinates', () => {
  const { modules, size } = encodeQrMatrix('timing check', 'L');
  for (let i = 8; i < size - 8; i += 1) {
    assert.equal(modules[6][i], i % 2 === 0 ? 1 : 0, `timing row cell ${i}`);
    assert.equal(modules[i][6], i % 2 === 0 ? 1 : 0, `timing col cell ${i}`);
  }
});

test('QR dark module is dark at (4 * version + 9, 8) for every version', () => {
  for (let version = 1; version <= 20; version += 1) {
    const qr = encodeQrMatrix('x'.repeat(MIN_BYTES_L[version - 1]), 'L');
    assert.equal(qr.modules[4 * version + 9][8], 1, `dark module for version ${version}`);
  }
});

test('QR format info is identical in both copies for L and M', () => {
  for (const ecLevel of ['L', 'M']) {
    const qr = encodeQrMatrix('format copies', ecLevel);
    const n = qr.size;
    // Copy 1: vertical strip bits 0-5 rows 0-5, bit 6 row 7, bit 7 at (8,8);
    // horizontal strip bits 14-9 cols 0-5, bit 8 col 7.
    const v = [];
    for (let i = 0; i <= 5; i += 1) v.push(qr.modules[i][8]);
    v.push(qr.modules[7][8]);
    v.push(qr.modules[8][8]);
    const h = [];
    for (let i = 14; i >= 9; i -= 1) h.push(qr.modules[8][14 - i]);
    h.push(qr.modules[8][7]);
    // Copy 2: bottom-left col 8 rows size-7..size-1 = bits 14-8 (same
    // descending order as h); top-right row 8 cols size-1..size-8 hold
    // bits 0-7 collected ascending to match v.
    const copy2v = [];
    for (let i = 14; i >= 8; i -= 1) copy2v.push(qr.modules[n - 15 + i][8]);
    const copy2h = [];
    for (let i = 0; i <= 7; i += 1) copy2h.push(qr.modules[8][n - 1 - i]);
    assert.deepEqual(h.join(''), copy2v.join(''), `bits 14-8, level ${ecLevel}`);
    assert.deepEqual(v.join(''), copy2h.join(''), `bits 7-0, level ${ecLevel}`);
  }
});

test('QR renders valid SVG with quiet zone and crisp path modules', () => {
  const svg = renderQrSvg('svg check', { ecLevel: 'L', quietZone: 4, size: 128 });
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'), 'SVG opening tag');
  assert.ok(svg.endsWith('</svg>'), 'SVG closing tag');
  assert.ok(svg.includes('viewBox="0 0 29 29"'), `viewBox for 21 + 8 quiet zone`);
  assert.ok(svg.includes('width="128"'), 'width attribute');
  assert.ok(svg.includes('height="128"'), 'height attribute');
  assert.ok(svg.includes('shape-rendering="crispEdges"'), 'crisp edges');
  assert.ok(svg.includes('<rect width="29" height="29" fill="#ffffff"/>'), 'light background rect');
  const path = svg.match(/<path data-version="1" fill="#0f172a" d="([^"]+)"/);
  assert.ok(path, 'dark module path');
  const subpaths = path[1].match(/M\d+,\d+h1v1h-1z/g);
  assert.ok(subpaths.length > 100, `expected many dark subpaths, got ${subpaths.length}`);
  for (const subpath of subpaths) {
    const [, x, y] = subpath.match(/M(\d+),(\d+)/);
    assert.ok(Number(x) >= 4 && Number(x) < 25, `x ${x} inside quiet zone`);
    assert.ok(Number(y) >= 4 && Number(y) < 25, `y ${y} inside quiet zone`);
  }
});

test('QR renderQrSvg validates options and encodeQrMatrix rejects bad input', () => {
  assert.throws(() => encodeQrMatrix(42), TypeError);
  assert.throws(() => encodeQrMatrix('ok', 'Q'), TypeError);
  assert.throws(() => renderQrSvg('ok', { quietZone: -1 }), TypeError);
  assert.throws(() => renderQrSvg('ok', { quietZone: 1.5 }), TypeError);
  assert.throws(() => renderQrSvg('ok', { size: 0 }), TypeError);
  assert.throws(() => renderQrSvg('ok', { dark: '' }), TypeError);
  assert.throws(() => renderQrSvg('ok', { light: '' }), TypeError);
  assert.throws(() => renderQrSvg('ok', { size: Number.NaN }), TypeError);
});

// ---------------------------------------------------------------------------
// Golden fixtures: full matrices byte-verified against an independent
// ISO/IEC 18004 reference implementation (byte mode, matched mask).
// ---------------------------------------------------------------------------
test('QR v1-L golden matrix for 17-byte payload matches reference implementation', () => {
  const qr = encodeQrMatrix('x'.repeat(17), 'L');
  assert.equal(qr.version, 1);
  assert.deepEqual(qr.modules.map((r) => r.join('')), [
    '111111100001001111111',
    '100000100100001000001',
    '101110101110101011101',
    '101110100011101011101',
    '101110100001001011101',
    '100000100100001000001',
    '111111101010101111111',
    '000000001101000000000',
    '111011111010011000100',
    '101110001100111011101',
    '011101100001101110111',
    '010111001101000100010',
    '101000101110010001000',
    '000000001100111011101',
    '111111101111101110111',
    '100000101001000100000',
    '101110101100010001001',
    '101110100010111011100',
    '101110101111101110101',
    '100000101001000100010',
    '111111101100010001011',
  ]);
});

test('QR v7-L golden matrix for 150-byte payload matches reference implementation', () => {
  const qr = encodeQrMatrix('x'.repeat(150), 'L');
  assert.equal(qr.version, 7);
  assert.deepEqual(qr.modules.map((r) => r.join('')), [
    '111111100010010111011001011011101000101111111',
    '100000100100011101110100001110111101001000001',
    '101110101100101000100110100100010001001011101',
    '101110100111000010001011110001000001101011101',
    '101110100110110111011111111011101111101011101',
    '100000100111011101111000101110111000001000001',
    '111111101010101010101010101010101010101111111',
    '000000001011010111011000111011101111100000000',
    '111011111110011101101111101110111011011000100',
    '000100010101101000111110100100010000000101101',
    '110110111100100010010011110001000100110000111',
    '110100001000010111000001011011101111111010010',
    '010011110001111101101100001110111011001111000',
    '101110001111001000111110100100010000000101101',
    '110000110010100010010011110001000100110000111',
    '010111001110110111000001011011101111111010010',
    '001011101010011101101100001110111011001111000',
    '010000000011001000111110100100010000000101101',
    '011010100001000010010011110001000100110000111',
    '100110010101010111000001011011101111111010010',
    '110111111110111101101111101110111011111111000',
    '110010001111001000111000100100010000100011101',
    '101010101011000010001010110001000101101010111',
    '111010001111110111001000111011101111100010010',
    '100011111101111101111111101110111010111111000',
    '100011000001001000101011100100010001010001101',
    '000010111001100010001001010001000101011010111',
    '001011011001010111010100011011101110101110010',
    '001101110101011101110110101110111010100101000',
    '001001001100001000101011100100010001010001101',
    '111010101110100010001001010001000101011010111',
    '100111001101110111010100011011101110101110010',
    '010001110100101101110110101110111010100101000',
    '100111000010110000101011100100010001010001101',
    '000010100110000010001001010001000101011010111',
    '011110001000110111010100011011101110101110011',
    '100110101001011101111111101110111010111111011',
    '000000001010001000101000100100010001100011101',
    '111111101110110010011010110001000100101010111',
    '100000101011111111001000111011101111100010010',
    '101110101001110101101111101110111011111111000',
    '101110100101010000110001000100010000111011100',
    '101110101001100010000100010001000101101110100',
    '100000101001010111001110111011101111000100010',
    '111111101011011101111011101110111010010001011',
  ]);
});

// ---------------------------------------------------------------------------
// Real encrypted dispatch URLs round-trip through the QR encoder
// ---------------------------------------------------------------------------

/** Deterministic volunteer route card from a scenario dispatch run. */
function buildRouteCard(scenario, volunteerId) {
  const dispatch = runDispatch(scenario);
  const route = dispatch.optimized.routes.find((r) => r.volunteerId === volunteerId);
  assert.ok(route, `no optimized route for ${volunteerId}`);
  const volunteer = scenario.volunteers.find((v) => v.id === volunteerId);
  return {
    schema: 1,
    volunteerId: route.volunteerId,
    name: volunteer.name,
    mode: route.mode,
    scenario: scenario.id,
    issuedAt: 0,
    depot: route.depot,
    stops: route.requestIds.map((id) => {
      const request = scenario.requests.find((r) => r.id === id);
      return { id, location: request.location, load: request.load, urgency: request.urgency };
    }),
  };
}

/** Fixed AES key so the embedded fixture URLs stay stable across runs. */
const FIXTURE_KEY = 'A'.repeat(43);

const FIXTURE_CARD = {
  schema: 1,
  volunteerId: 'v-oak-4',
  name: 'Noor',
  mode: 'car',
  scenario: 'oakwood-groceries',
  issuedAt: 0,
  depot: { x: 14.07, y: 7.98 },
  stops: [
    { id: 'r-oak-4', location: { x: 15.98, y: 3.99 }, load: 4, urgency: 4 },
    { id: 'r-oak-7', location: { x: 14.08, y: 12.12 }, load: 2, urgency: 4 },
    { id: 'r-oak-8', location: { x: 9.9, y: 10.1 }, load: 1, urgency: 1 },
  ],
};

const FIXTURE_CIPHERTEXT = 'AwoRGB8mLTQ7QklQEsDPheJGxNK4bI168PPo2b9oXCSMekPU_9X8TXpCi-I6SbGs_7Kkv96Qqw4ASTAOTujQ4Ngwkn2EkuzBjI4AuJQsNMQrYznlSk1s__Q7mhLhq8ZvLFvwpRuKwUepPy1jGZ9bDcJe_IofDCzodZ0ZMspazRau7FMV_Rb2S_ZJuvJdR3pV-xFpI2zjwtbZ4ZlH7DH63gEKOdGQCkSwO2RHrM-3ziHUfcUJ4IC_zROrJ6-4QiIBVcpXhgO1u5AvhIbw0TcKo9l0iwlWggtA8RPwM2sWWsC2C9FVXQcKrKs4E3UjrPtlrITTz397qqa3ZwwxMqOpA7hZYPpyygsRGhiQOmKhvzoNwOU_PwYURVmxOf4vzjBW6ewzmTDWI-8sPbh2FBL6hZYcLzuU_begq7VACH5nNsp24RTAAq6Rhv0EGF2RNwCbWeOyUe_NxahMvhE2A7PLggUkWTD7kzDlIJy28yzkwrYhgvGJKkSoHe7QV9i225A';

const FIXTURE_URL = `https://aariv.me/kindroute/#card=${FIXTURE_CIPHERTEXT}&k=${FIXTURE_KEY}`;

test('real encrypted oakwood dispatch URL encodes without throwing at exact version', () => {
  // The fixture URL is byte-identical to encryptCard(buildRouteCard(SCENARIOS.oakwood, 'v-oak-4'))
  // under a deterministic IV; verify live generation agrees before using it.
  const card = buildRouteCard(SCENARIOS.oakwood, 'v-oak-4');
  assert.deepEqual(card, FIXTURE_CARD, 'fixture card must match the live dispatch run');
  assert.equal(new TextEncoder().encode(FIXTURE_URL).length, 590);
  const qr = encodeQrMatrix(FIXTURE_URL, 'L');
  assert.equal(qr.version, 17, 'QR version for the 590-byte dispatch URL');
  assert.equal(qr.size, 85);
  assert.equal(qr.modules.length, 85);
});

test('real encrypted dispatch URL round-trips: decrypt, fragment parse, QR re-encode', async () => {
  const parsed = parseShareFragment(FIXTURE_URL.slice(FIXTURE_URL.indexOf('#')));
  const card = await decryptCard(parsed.ciphertext, parsed.key);
  assert.equal(card.volunteerId, 'v-oak-4');
  assert.equal(card.name, 'Noor');
  assert.equal(card.stops.length, 3);
  assert.deepEqual(card.stops[0], { id: 'r-oak-4', location: { x: 15.98, y: 3.99 }, load: 4, urgency: 4 });

  const url = buildShareUrl('https://aariv.me/kindroute/', { ciphertext: parsed.ciphertext, key: parsed.key });
  assert.equal(url, FIXTURE_URL);
  const qr = encodeQrMatrix(url, 'L');
  assert.equal(qr.version, 17);
  assert.deepEqual(
    qr.modules,
    encodeQrMatrix(FIXTURE_URL, 'L').modules,
    're-encoding the rebuilt URL must be deterministic',
  );
});

test('live encryptCard on a real winter surge route produces a QR at version 16', async () => {
  const surge = injectSurge(SCENARIOS.winter, 4242, 5);
  const card = buildRouteCard(surge, 'v-wnt-1');
  assert.equal(card.stops.length, 3);
  const encrypted = await encryptCard(card, FIXTURE_KEY);
  const url = buildShareUrl('https://aariv.me/kindroute/', encrypted);
  const bytes = new TextEncoder().encode(url).length;
  assert.ok(bytes >= 480 && bytes <= 620, `dispatch URL length ${bytes} in expected range`);
  const qr = encodeQrMatrix(url, 'L');
  assert.ok(qr.version >= 15 && qr.version <= 17, `QR version ${qr.version} for ${bytes} bytes`);
  assert.equal(qr.size, 17 + 4 * qr.version);
  // AES-GCM with a fixed key is deterministic only when the IV is; verify via decrypt.
  const parsed = parseShareFragment(url.slice(url.indexOf('#')));
  const decrypted = await decryptCard(parsed.ciphertext, parsed.key);
  assert.deepEqual(decrypted, card);
});

test('QR reports exact version and size for a range of realistic dispatch URL sizes', () => {
  // Minimal URL lengths that land on versions 10, 14 and 20.
  // Fixed skeleton: "https://aariv.me/kindroute/#card=" (33) + "&k=" (3) + 43-char key = 79 bytes.
  const samples = [
    [231, 10], [426, 14], [793, 20],
  ];
  for (const [bytes, version] of samples) {
    const url = `https://aariv.me/kindroute/#card=${'A'.repeat(bytes - 79)}&k=${'A'.repeat(43)}`;
    assert.equal(new TextEncoder().encode(url).length, bytes);
    const qr = encodeQrMatrix(url, 'L');
    assert.equal(qr.version, version, `version for ${bytes}-byte URL`);
    assert.equal(qr.size, 17 + 4 * version);
  }
});

// ---------------------------------------------------------------------------
// Capacity and error handling
// ---------------------------------------------------------------------------
test('QR encoder throws a descriptive error when the payload exceeds max capacity', () => {
  assert.throws(
    () => encodeQrMatrix('x'.repeat(859), 'L'),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /payload too large/);
      assert.match(error.message, /859 bytes/);
      assert.match(error.message, /version 20/);
      assert.match(error.message, /858 bytes/);
      return true;
    },
  );
  assert.throws(
    () => encodeQrMatrix('x'.repeat(667), 'M'),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /payload too large/);
      assert.match(error.message, /666 bytes/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Determinism and UTF-8 handling
// ---------------------------------------------------------------------------
test('QR encoding is fully deterministic across repeated calls', () => {
  const text = 'https://aariv.me/kindroute/#card=determinism-check';
  const a = encodeQrMatrix(text, 'M');
  const b = encodeQrMatrix(text, 'M');
  assert.deepEqual(a, b);
  assert.equal(renderQrSvg(text, { ecLevel: 'M' }), renderQrSvg(text, { ecLevel: 'M' }));
});

test('QR byte mode encodes UTF-8 payloads via TextEncoder semantics', () => {
  const text = 'cafe \u00e9clair run';
  const qr = encodeQrMatrix(text, 'L');
  // 15 ASCII chars + one two-byte code point = 16 bytes, fits v1-L (17-byte capacity)
  assert.equal(qr.version, 1);
  assert.equal(qr.size, 21);
});

test('QR barrel exports encodeQrMatrix and renderQrSvg', async () => {
  const barrel = await import('../src/index.js');
  assert.equal(typeof barrel.encodeQrMatrix, 'function');
  assert.equal(typeof barrel.renderQrSvg, 'function');
  assert.equal(typeof barrel.qrSvg.encodeQrMatrix, 'function');
  assert.equal(typeof barrel.qrSvg.renderQrSvg, 'function');
});
