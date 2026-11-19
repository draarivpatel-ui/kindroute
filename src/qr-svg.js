/**
 * Zero-dependency ISO/IEC 18004 QR Code encoder and SVG renderer.
 *
 * Implements byte-mode encoding, Reed-Solomon error correction over GF(256),
 * all 40 versions (this module supports versions 1 through 20), finder,
 * separator, timing, alignment and dark-module patterns, BCH format and
 * version information, data placement with the standard zig-zag interleaver,
 * all eight mask patterns and the standard penalty-rule mask selector.
 *
 * Everything is pure ECMAScript: no DOM, no Node-only imports, no packages.
 * The renderer emits a single <path> containing one subpath per dark module so
 * the SVG stays small and scales with crisp, rectangle-exact edges.
 */

// ---------------------------------------------------------------------------
// Standard tables (ISO/IEC 18004, Tables 7, 9 and 13)
// ---------------------------------------------------------------------------

/** Total codewords in each version, 1 through 20. */
const TOTAL_CODEWORDS = [
  26, 44, 70, 100, 134, 172, 196, 242, 292, 346,
  404, 466, 532, 581, 655, 733, 815, 901, 991, 1085,
];

/**
 * Error-correction codewords per block for each version (L then M).
 * Indexed by version, so ECW_PER_BLOCK.L[v - 1] is version v.
 */
const ECW_PER_BLOCK = {
  L: [
    7, 10, 15, 20, 26, 18, 20, 24, 30, 18,
    20, 24, 26, 30, 22, 24, 28, 30, 28, 28,
  ],
  M: [
    10, 16, 26, 18, 24, 16, 18, 22, 22, 26,
    30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
  ],
};

/**
 * Error-correction block groups per version. Each version maps to one or two
 * `[blockCount, dataCodewordsPerBlock]` groups; the group with the shorter
 * blocks always comes first, as required by ISO/IEC 18004.
 */
const EC_BLOCKS = {
  L: [
    [[1, 19]], [[1, 34]], [[1, 55]], [[1, 80]], [[1, 108]],
    [[2, 68]], [[2, 78]], [[2, 97]], [[2, 116]], [[2, 68], [2, 69]],
    [[4, 81]], [[2, 92], [2, 93]], [[4, 107]], [[3, 115], [1, 116]],
    [[5, 87], [1, 88]], [[5, 98], [1, 99]], [[1, 107], [5, 108]],
    [[5, 120], [1, 121]], [[3, 113], [4, 114]], [[3, 107], [5, 108]],
  ],
  M: [
    [[1, 16]], [[1, 28]], [[1, 44]], [[2, 32]], [[2, 43]],
    [[4, 27]], [[4, 31]], [[2, 38], [2, 39]], [[3, 36], [2, 37]],
    [[4, 43], [1, 44]], [[1, 50], [4, 51]], [[6, 36], [2, 37]],
    [[8, 37], [1, 38]], [[4, 40], [5, 41]], [[5, 41], [5, 42]],
    [[7, 45], [3, 46]], [[10, 46], [1, 47]], [[9, 43], [4, 44]],
    [[3, 44], [11, 45]], [[3, 41], [13, 42]],
  ],
};

/** Format information bits for each EC level, indexed by the 3-bit level id. */
const EC_FORMAT_BITS = { L: 0b01, M: 0b00 };

/** Center coordinates of alignment patterns for each version (Table E.1). */
const ALIGNMENT_POSITIONS = [
  null,
  [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
  [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66],
  [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78],
  [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90],
];

// ---------------------------------------------------------------------------
// GF(256) arithmetic and Reed-Solomon over the primitive polynomial 0x11d
// ---------------------------------------------------------------------------

const EXP_TABLE = new Uint8Array(512);
const LOG_TABLE = new Uint8Array(256);
(function buildGaloisTables() {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP_TABLE[i] = x;
    LOG_TABLE[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP_TABLE[i] = EXP_TABLE[i - 255];
})();

function gfMultiply(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP_TABLE[LOG_TABLE[a] + LOG_TABLE[b]];
}

/** Generator polynomial for an `ecCount`-byte Reed-Solomon code (monic, high order first). */
function rsGenerator(ecCount) {
  let polynomial = [1];
  for (let i = 0; i < ecCount; i += 1) {
    const root = EXP_TABLE[i];
    const next = new Array(polynomial.length + 1).fill(0);
    for (let j = 0; j < polynomial.length; j += 1) {
      next[j] ^= polynomial[j];
      next[j + 1] ^= gfMultiply(polynomial[j], root);
    }
    polynomial = next;
  }
  return polynomial;
}

/** Append `ecCount` Reed-Solomon error-correction codewords to `data`. */
function reedSolomonRemainder(data, ecCount) {
  const generator = rsGenerator(ecCount);
  const remainder = new Uint8Array(ecCount);
  for (const byte of data) {
    const factor = byte ^ remainder[0];
    remainder.copyWithin(0, 1);
    remainder[ecCount - 1] = 0;
    for (let i = 0; i < ecCount; i += 1) {
      remainder[i] ^= gfMultiply(generator[i + 1], factor);
    }
  }
  return remainder;
}

// ---------------------------------------------------------------------------
// Bit stream, version selection and codeword construction
// ---------------------------------------------------------------------------

/** Build the 4-bit mode indicator + character-count + byte payload + terminator bit stream. */
function buildBitStream(dataBytes, version) {
  const countBits = version <= 9 ? 8 : 16;
  const bits = [];
  const appendBits = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  appendBits(0b0100, 4); // byte mode
  appendBits(dataBytes.length, countBits);
  for (const byte of dataBytes) appendBits(byte, 8);
  return bits;
}

/** Number of data codewords for a version and EC level. */
function dataCodewordCount(version, ecLevel) {
  return EC_BLOCKS[ecLevel][version - 1]
    .reduce((sum, [count, dcCount]) => sum + count * dcCount, 0);
}

/** Pick the smallest version that holds `byteLength` UTF-8 bytes at `ecLevel`. */
function chooseVersion(byteLength, ecLevel) {
  for (let version = 1; version <= 20; version += 1) {
    const headerBits = 4 + (version <= 9 ? 8 : 16);
    if (headerBits + byteLength * 8 <= dataCodewordCount(version, ecLevel) * 8) return version;
  }
  throw new Error(
    `payload too large: ${byteLength} bytes exceeds the maximum capacity of ` +
    `version 20 at error-correction level ${ecLevel} (${dataCodewordCount(20, ecLevel) - 3} bytes)`,
  );
}

/** Build the final interleaved data + error-correction codeword sequence. */
function buildCodewords(dataBytes, version, ecLevel) {
  const ecCount = ECW_PER_BLOCK[ecLevel][version - 1];
  const groups = EC_BLOCKS[ecLevel][version - 1];

  const bits = buildBitStream(dataBytes, version);
  const capacityBits = groups.reduce((sum, [blocks, dc]) => sum + blocks * dc, 0) * 8;
  // Terminator: up to 4 zero bits, never exceeding the data capacity.
  for (let i = 0; i < 4 && bits.length < capacityBits; i += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);
  const dataCodewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j];
    dataCodewords.push(byte);
  }
  // Pad to the exact data capacity with alternating pad bytes.
  const padBytes = [0xec, 0x11];
  for (let i = 0; dataCodewords.length < capacityBits / 8; i += 1) {
    dataCodewords.push(padBytes[i % 2]);
  }

  // Split into blocks, compute RS remainders, then interleave data and EC.
  const blocks = [];
  let offset = 0;
  for (const [count, dcCount] of groups) {
    for (let i = 0; i < count; i += 1) {
      const data = Uint8Array.from(dataCodewords.slice(offset, offset + dcCount));
      offset += dcCount;
      blocks.push({ data, ec: reedSolomonRemainder(data, ecCount) });
    }
  }
  const result = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i += 1) {
    for (const block of blocks) if (i < block.data.length) result.push(block.data[i]);
  }
  for (let i = 0; i < ecCount; i += 1) {
    for (const block of blocks) result.push(block.ec[i]);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Matrix construction
// ---------------------------------------------------------------------------

function createMatrix(size) {
  return Array.from({ length: size }, () => new Uint8Array(size));
}

function setFinderPattern(matrix, row, col) {
  const size = matrix.length;
  for (let r = -1; r <= 7; r += 1) {
    for (let c = -1; c <= 7; c += 1) {
      const y = row + r;
      const x = col + c;
      if (y < 0 || y >= size || x < 0 || x >= size) continue;
      const inner = r >= 0 && r <= 6 && c >= 0 && c <= 6;
      const dark = inner && (
        r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4)
      );
      matrix[y][x] = dark ? 1 : 0;
    }
  }
}

function setAlignmentPattern(matrix, row, col) {
  for (let dr = -2; dr <= 2; dr += 1) {
    for (let dc = -2; dc <= 2; dc += 1) {
      const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
      matrix[row + dr][col + dc] = dark ? 1 : 0;
    }
  }
}

function setFunctionPatterns(matrix, version) {
  const size = matrix.length;
  const reserved = createMatrix(size);
  const reserve = (row, col) => { reserved[row][col] = 1; };

  setFinderPattern(matrix, 0, 0);
  setFinderPattern(matrix, 0, size - 7);
  setFinderPattern(matrix, size - 7, 0);
  for (let r = -1; r <= 7; r += 1) {
    for (let c = -1; c <= 7; c += 1) {
      reserveForFinder(reserve, size, 0, 0, r, c);
      reserveForFinder(reserve, size, 0, size - 7, r, c);
      reserveForFinder(reserve, size, size - 7, 0, r, c);
    }
  }

  // Timing patterns: row 6 and column 6 alternate, dark on even coordinates.
  for (let i = 8; i < size - 8; i += 1) {
    matrix[6][i] = i % 2 === 0 ? 1 : 0;
    matrix[i][6] = i % 2 === 0 ? 1 : 0;
    reserve(6, i);
    reserve(i, 6);
  }

  // Alignment patterns, skipping the three finder-pattern corners.
  const positions = ALIGNMENT_POSITIONS[version - 1];
  if (positions) {
    const last = positions.length - 1;
    for (let i = 0; i <= last; i += 1) {
      for (let j = 0; j <= last; j += 1) {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
        const row = positions[i];
        const col = positions[j];
        setAlignmentPattern(matrix, row, col);
        for (let dr = -2; dr <= 2; dr += 1) {
          for (let dc = -2; dc <= 2; dc += 1) reserve(row + dr, col + dc);
        }
      }
    }
  }

  // Format-information reserved areas around the top-left finder.
  // Both the vertical strip (column 8) and horizontal strip (row 8) include
  // cells past the separator at index 8, up to index 14.
  for (let i = 0; i < 15; i += 1) {
    const index = i < 6 ? i : (i < 8 ? i + 1 : size - 15 + i);
    reserve(index, 8);
    reserve(8, index);
  }
  // Second copy: bottom-left (column 8, rows size-8..size-1) and
  // top-right (row 8, columns size-8..size-1).
  for (let i = 0; i < 8; i += 1) {
    reserve(size - 1 - i, 8);
    reserve(8, size - 1 - i);
  }
  // The dark module at (4 * version + 9, 8) == (size - 8, 8) is reserved here
  // and written by placeFormatInfo after the mask has been selected.
  reserve(4 * version + 9, 8);

  // Version information blocks for version >= 7.
  if (version >= 7) {
    for (let i = 0; i < 18; i += 1) {
      reserve(Math.floor(i / 3), size - 11 + (i % 3));
      reserve(size - 11 + (i % 3), Math.floor(i / 3));
    }
  }
  return reserved;
}

function reserveForFinder(reserve, size, baseRow, baseCol, r, c) {
  const y = baseRow + r;
  const x = baseCol + c;
  if (y >= 0 && y < size && x >= 0 && x < size) reserve(y, x);
}

/** BCH(15,5) encoding of the 5-bit format value, masked with 101010000010010. */
function formatBits(ecLevel, mask) {
  const data = (EC_FORMAT_BITS[ecLevel] << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  const bits = ((data << 10) | remainder) ^ 0x5412;
  return bits & 0x7fff;
}

/** BCH(18,6) encoding of the version number. */
function versionBits(version) {
  let remainder = version;
  for (let i = 0; i < 12; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
  return (version << 12) | remainder;
}

/**
 * Place the two copies of the 15-bit format information and the dark module
 * (ISO/IEC 18004, 7.9 and Figure 25).
 *
 * Copy 1 wraps the top-left finder: the vertical strip (column 8) carries
 * bits 0-7 LSB-first (skipping the timing cell at row 6), the horizontal
 * strip (row 8) carries bits 14-8 MSB-first (skipping the timing cell at
 * column 6); both meet at (8, 8) = bit 7.
 * Copy 2 mirrors this around the other two finders: bits 14-8 down the
 * bottom-left column 8 and bits 0-7 leftward along row 8 from column
 * size - 1. The dark module sits at (size - 8, 8).
 */
function placeFormatInfo(matrix, ecLevel, mask) {
  const size = matrix.length;
  const bits = formatBits(ecLevel, mask);
  const bit = (i) => (bits >>> i) & 1;
  // Copy 1, vertical strip (column 8): bits 0-5 at rows 0-5, bit 6 at row 7,
  // bit 7 at row 8. Row 6 belongs to the timing pattern.
  for (let i = 0; i <= 5; i += 1) matrix[i][8] = bit(i);
  matrix[7][8] = bit(6);
  matrix[8][8] = bit(7);
  // Copy 1, horizontal strip (row 8): bits 14-9 at columns 5-0, bit 8 at
  // column 7. Column 6 belongs to the timing pattern.
  for (let i = 9; i <= 14; i += 1) matrix[8][14 - i] = bit(i);
  matrix[8][7] = bit(8);
  // Copy 2, bottom-left (column 8): bits 14-8 at rows size-1 down to size-7.
  for (let i = 8; i <= 14; i += 1) matrix[size - 15 + i][8] = bit(i);
  // Copy 2, top-right (row 8): bits 0-7 at columns size-1 down to size-8.
  for (let i = 0; i <= 7; i += 1) matrix[8][size - 1 - i] = bit(i);
  // Fixed dark module beside the bottom-left copy.
  matrix[size - 8][8] = 1;
}

function placeVersionInfo(matrix, version) {
  if (version < 7) return;
  const size = matrix.length;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i += 1) {
    const value = (bits >>> i) & 1;
    matrix[Math.floor(i / 3)][size - 11 + (i % 3)] = value;
    matrix[size - 11 + (i % 3)][Math.floor(i / 3)] = value;
  }
}

/** Standard mask condition for pattern `mask` at position (row, col). */
function maskApplies(mask, row, col) {
  switch (mask) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    case 7: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
    default: return false;
  }
}

/** Place codewords into the free modules in two-module-wide upward/downward columns. */
function placeCodewords(matrix, reserved, codewords, mask) {
  const size = matrix.length;
  let bitIndex = 0;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5; // skip the vertical timing column
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (let i = 0; i < 2; i += 1) {
        const x = col - i;
        if (reserved[row][x]) continue;
        let value = 0;
        if (bitIndex < codewords.length * 8) {
          value = (codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1;
          bitIndex += 1;
        }
        if (maskApplies(mask, row, x)) value ^= 1;
        matrix[row][x] = value;
      }
    }
    upward = !upward;
  }
}

// ---------------------------------------------------------------------------
// ISO/IEC 18004 penalty rules (N1..N4)
// ---------------------------------------------------------------------------

function penaltyScore(matrix) {
  const size = matrix.length;
  let penalty = 0;

  // N1: five or more consecutive same-colored modules in a row or column.
  for (let i = 0; i < size; i += 1) {
    let runRow = 1;
    let runCol = 1;
    for (let j = 1; j < size; j += 1) {
      runRow = matrix[i][j] === matrix[i][j - 1] ? runRow + 1 : 1;
      if (runRow === 5) penalty += 3;
      else if (runRow > 5) penalty += 1;
      runCol = matrix[j][i] === matrix[j - 1][i] ? runCol + 1 : 1;
      if (runCol === 5) penalty += 3;
      else if (runCol > 5) penalty += 1;
    }
  }

  // N2: each 2x2 block of a single color adds 3.
  for (let row = 0; row < size - 1; row += 1) {
    for (let col = 0; col < size - 1; col += 1) {
      const value = matrix[row][col];
      if (value === matrix[row][col + 1] && value === matrix[row + 1][col] && value === matrix[row + 1][col + 1]) {
        penalty += 3;
      }
    }
  }

  // N3: finder-like 1:1:3:1:1 patterns with four light modules on one side.
  // Patterns aligned with a finder position count unconditionally; otherwise
  // the light area is checked with boundary clipping and the search resumes
  // four modules into a failed match so overlapping patterns are counted.
  const n3Line = (sequence) => {
    const length = sequence.length;
    const core = [1, 0, 1, 1, 1, 0, 1];
    let count = 0;
    let start = 0;
    for (;;) {
      let idx = -1;
      scan: for (let i = start; i <= length - 7; i += 1) {
        for (let k = 0; k < 7; k += 1) {
          if (sequence[i + k] !== core[k]) continue scan;
        }
        idx = i;
        break;
      }
      if (idx === -1) return count;
      let offset = idx + 7;
      let leftLight = true;
      for (let i = Math.max(idx - 4, 0); i < idx; i += 1) {
        if (sequence[i] === 1) { leftLight = false; break; }
      }
      let rightLight = true;
      for (let i = idx + 7; i < Math.min(idx + 11, length); i += 1) {
        if (sequence[i] === 1) { rightLight = false; break; }
      }
      if (idx === 0 || idx === length - 7 || leftLight || rightLight) count += 40;
      else offset = idx + 4;
      start = offset;
    }
  };
  for (let row = 0; row < size; row += 1) penalty += n3Line(matrix[row]);
  for (let col = 0; col < size; col += 1) {
    const column = Array.from({ length: size }, (_, i) => matrix[i][col]);
    penalty += n3Line(column);
  }

  // N4: deviation of the dark-module ratio from 50%, in steps of 5%.
  let dark = 0;
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) dark += matrix[row][col];
  }
  const percent = (dark * 100) / (size * size);
  penalty += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return penalty;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Encode text into an ISO/IEC 18004 QR matrix (byte mode).
 *
 * @param {string} text text to encode; must be valid Unicode
 * @param {'L'|'M'} [ecLevel='L'] error-correction level
 * @returns {{version:number, size:number, modules:number[][]}} matrix rows of 0/1
 */
export function encodeQrMatrix(text, ecLevel = 'L') {
  if (typeof text !== 'string') throw new TypeError('QR payload must be a string');
  if (ecLevel !== 'L' && ecLevel !== 'M') {
    throw new TypeError('QR error-correction level must be "L" or "M"');
  }
  const dataBytes = new TextEncoder().encode(text);
  const version = chooseVersion(dataBytes.length, ecLevel);
  const size = 17 + 4 * version; // 21 + 4*(version - 1)
  const codewords = buildCodewords(dataBytes, version, ecLevel);
  const base = createMatrix(size);
  const reserved = setFunctionPatterns(base, version);

  let best = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = base.map((row) => Uint8Array.from(row));
    placeCodewords(candidate, reserved, codewords, mask);
    // Evaluate penalties before writing format/version information, as the
    // standard's evaluation step operates on the masked encoding region.
    const score = penaltyScore(candidate);
    placeFormatInfo(candidate, ecLevel, mask);
    placeVersionInfo(candidate, version);
    if (best === null || score < best.score) best = { score, modules: candidate };
  }

  return {
    version,
    size,
    modules: best.modules.map((row) => Array.from(row)),
  };
}

/**
 * Render text as a crisp, dependency-free SVG QR code.
 *
 * The dark modules are emitted as a single <path> with one `M x,y h1v1h-1z`
 * subpath each, so the image stays a compact DOM node and scales without blur.
 *
 * @param {string} text text to encode
 * @param {{ecLevel?:'L'|'M', quietZone?:number, dark?:string, light?:string, size?:number}} [options]
 * @returns {string} a standalone SVG document string
 */
export function renderQrSvg(text, {
  ecLevel = 'L',
  quietZone = 4,
  dark = '#0f172a',
  light = '#ffffff',
  size = 200,
} = {}) {
  if (!Number.isInteger(quietZone) || quietZone < 0) {
    throw new TypeError('quietZone must be a non-negative integer');
  }
  if (!Number.isFinite(size) || size <= 0) {
    throw new TypeError('size must be a positive finite number');
  }
  if (typeof dark !== 'string' || typeof light !== 'string' || !dark || !light) {
    throw new TypeError('dark and light must be non-empty color strings');
  }
  const { version, size: dimension, modules } = encodeQrMatrix(text, ecLevel);

  const total = dimension + quietZone * 2;
  let path = '';
  for (let row = 0; row < dimension; row += 1) {
    for (let col = 0; col < dimension; col += 1) {
      if (modules[row][col]) {
        path += `M${col + quietZone},${row + quietZone}h1v1h-1z`;
      }
    }
  }
  const scale = Number(size.toPrecision(12));
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${scale}" height="${scale}" ` +
    `viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">` +
    `<rect width="${total}" height="${total}" fill="${light}"/>` +
    `<path data-version="${version}" fill="${dark}" d="${path}"/>` +
    `</svg>`
  );
}

export default { encodeQrMatrix, renderQrSvg };
