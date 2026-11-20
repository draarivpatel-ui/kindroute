/**
 * Exact O(n^3) Hungarian (Munkres / Jonker-Volgenant) bipartite matcher.
 *
 * Solves the rectangular assignment problem: given an n x m cost matrix,
 * choose a maximum-cardinality set of row/column pairs with minimum total
 * cost. Rows typically represent volunteer capacity slots, columns represent
 * community requests. There are no dependencies and no global state.
 *
 * The implementation uses potentials with augmenting paths (the O(n^3)
 * shortest-augmenting-path form). It additionally records a structured
 * `steps` trace so a UI can animate the real algorithm: row reduction,
 * column reduction, zero starring, column covering, augmenting paths and
 * the final assignment.
 */

/** Deep copy a matrix so callers never observe mutation. */
function cloneMatrix(matrix) {
  return matrix.map((row) => (Array.isArray(row) ? row.slice() : row));
}

/**
 * Validate a cost matrix. Every entry must be a finite number and rows must
 * all have the same length. Zero-width/height matrices are allowed and
 * produce an empty assignment.
 */
export function validateMatrix(matrix) {
  if (!Array.isArray(matrix)) {
    throw new TypeError('Cost matrix must be an array of rows');
  }
  const rows = matrix.length;
  if (rows === 0) return { rows: 0, cols: 0 };
  const cols = matrix[0]?.length ?? 0;
  if (!Array.isArray(matrix[0])) {
    throw new TypeError('Cost matrix rows must be arrays');
  }
  for (let i = 0; i < rows; i += 1) {
    if (!Array.isArray(matrix[i]) || matrix[i].length !== cols) {
      throw new TypeError(`Cost matrix row ${i} has a different length than row 0`);
    }
    for (let j = 0; j < cols; j += 1) {
      const value = matrix[i][j];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new TypeError(`Cost at (${i}, ${j}) must be a finite number`);
      }
    }
  }
  return { rows, cols };
}

/**
 * Expand volunteer-like objects into individual capacity slots. A volunteer
 * with capacity k becomes k consecutive slots with the same id and home.
 * The returned `slots` carry `volunteerId` and `slotIndex` for traceability.
 */
export function expandSlots(volunteers) {
  if (!Array.isArray(volunteers)) {
    throw new TypeError('volunteers must be an array');
  }
  const slots = [];
  for (const volunteer of volunteers) {
    if (volunteer == null || typeof volunteer !== 'object') {
      throw new TypeError('Each volunteer must be an object');
    }
    const rawCapacity = volunteer.capacity ?? 1;
    const capacity = Number.isFinite(rawCapacity) ? Math.max(0, Math.floor(rawCapacity)) : 0;
    for (let slotIndex = 0; slotIndex < capacity; slotIndex += 1) {
      slots.push({
        volunteerId: volunteer.id,
        slotIndex,
        volunteer,
      });
    }
  }
  return slots;
}

function makeStep(index, type, data) {
  return { index, type, ...data };
}

/**
 * Solve the assignment problem.
 *
 * @param {number[][]} rawMatrix cost matrix (rows = slots, cols = requests)
 * @param {object} [options]
 * @param {boolean} [options.expand=false] if true, accept volunteers via
 *        options.volunteers and expand them into slots before solving.
 * @param {string[]} [options.rowLabels] optional labels for trace output
 * @param {string[]} [options.colLabels] optional labels for trace output
 * @returns {{
 *   assignment: number[], totalCost: number, steps: object[],
 *   matchedCount: number, rowLabels: string[], colLabels: string[],
 *   orientation: 'normal'|'transposed', matrix: number[][]
 * }}
 *   `assignment[r] = c` for every matched row, otherwise -1.
 */
export function hungarian(rawMatrix, options = {}) {
  const matrix = cloneMatrix(rawMatrix);
  const { rows: initialRows, cols: initialCols } = validateMatrix(matrix);

  const rowLabels = options.rowLabels
    ? options.rowLabels.slice()
    : Array.from({ length: initialRows }, (_, i) => `row-${i}`);
  const colLabels = options.colLabels
    ? options.colLabels.slice()
    : Array.from({ length: initialCols }, (_, j) => `col-${j}`);

  if (initialRows === 0 || initialCols === 0) {
    return {
      assignment: Array(initialRows).fill(-1),
      totalCost: 0,
      steps: [makeStep(0, 'final-assignment', {
        title: 'Final assignment',
        detail: 'No rows or columns to match.',
        pairs: [],
        matrix,
        rowLabels,
        colLabels,
      })],
      matchedCount: 0,
      rowLabels,
      colLabels,
      orientation: 'normal',
      matrix,
    };
  }

  // Keep rows <= cols, the precondition of the O(n^3) solver. If the input
  // is taller than it is wide, solve the transpose and flip the result back.
  const transposed = initialRows > initialCols;
  const work = transposed ? transpose(matrix) : matrix;
  const n = work.length; // rows (smaller dimension)
  const m = work[0].length; // columns (larger dimension)
  const workRowLabels = transposed ? colLabels : rowLabels;
  const workColLabels = transposed ? rowLabels : colLabels;

  const steps = [];
  let stepIndex = 0;
  const push = (type, data) => {
    steps.push(makeStep(stepIndex, type, { title: STEP_TITLES[type], ...data }));
    stepIndex += 1;
  };

  const afterRows = work.map((row) => {
    const min = Math.min(...row);
    return row.map((v) => v - min);
  });
  const colMins = Array.from({ length: m }, (_, j) => Math.min(...afterRows.map((row) => row[j])));
  const afterCols = afterRows.map((row) => row.map((v, j) => v - colMins[j]));
  push('row-reduction', {
    detail: 'Subtract the smallest cost in each row. A zero now marks the cheapest request for that slot.',
    reductions: work.map((row, i) => {
      const min = Math.min(...row);
      return { row: i, label: workRowLabels[i], min, reduced: row.map((v) => v - min) };
    }),
    matrix: afterRows,
    rowLabels: workRowLabels.slice(),
    colLabels: workColLabels.slice(),
  });
  push('col-reduction', {
    detail: 'Subtract the smallest reduced cost in each column. Nonnegative costs with at least one zero per row and column remain.',
    reductions: colMins.map((min, j) => ({ col: j, label: workColLabels[j], min })),
    matrix: afterCols,
    rowLabels: workRowLabels.slice(),
    colLabels: workColLabels.slice(),
  });

  const starred = [];
  const starredCols = new Set();
  for (let i = 0; i < n; i += 1) {
    let best = -1;
    for (let j = 0; j < m; j += 1) {
      if (afterCols[i][j] === 0 && !starredCols.has(j)) {
        best = j;
        break;
      }
    }
    if (best >= 0) {
      starredCols.add(best);
      starred.push({ row: i, col: best, rowLabel: workRowLabels[i], colLabel: workColLabels[best] });
    }
  }
  push('star-zeros', {
    detail: 'Star one independent zero per row. A starred zero is a provisional match.',
    cells: starred,
    coveredCols: [],
    matrix: cloneMatrix(afterCols),
    rowLabels: workRowLabels.slice(),
    colLabels: workColLabels.slice(),
  });

  // Potentials based augmenting path solver. p[j] = row matched to column j
  // (0 means unmatched). way[j] tracks the predecessor column in the tree.
  const u = new Float64Array(n + 1);
  const v = new Float64Array(m + 1);
  const p = new Int32Array(m + 1);
  const way = new Int32Array(m + 1);

  for (let i = 1; i <= n; i += 1) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(m + 1).fill(Number.POSITIVE_INFINITY);
    const used = new Uint8Array(m + 1);
    const visitedColumns = [];

    do {
      used[j0] = 1;
      visitedColumns.push(j0);
      const i0 = p[j0];
      let delta = Number.POSITIVE_INFINITY;
      let j1 = -1;
      for (let j = 1; j <= m; j += 1) {
        if (used[j]) continue;
        const cur = work[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      if (j1 < 0 || !Number.isFinite(delta)) {
        throw new Error('Hungarian solver failed: no augmenting path found');
      }
      for (let j = 0; j <= m; j += 1) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);

    const covered = [];
    for (let j = 1; j <= m; j += 1) {
      if (p[j] !== 0) covered.push(j - 1);
    }
    push('cover-cols', {
      detail: 'Cover columns that already hold a match, then search the uncovered zeros for a new augmenting path.',
      coveredCols: covered,
      coveredLabels: covered.map((j) => workColLabels[j]),
      targetRow: i - 1,
      targetRowLabel: workRowLabels[i - 1],
      exploredColumns: visitedColumns.filter((j) => j > 0).map((j) => j - 1),
      matrix: cloneMatrix(work),
      rowLabels: workRowLabels.slice(),
      colLabels: workColLabels.slice(),
    });

    const path = [];
    let cursor = j0;
    while (cursor !== 0) {
      path.push({ row: p[cursor] - 1, col: cursor - 1, rowLabel: workRowLabels[p[cursor] - 1], colLabel: workColLabels[cursor - 1] });
      const previous = way[cursor];
      if (previous === undefined || previous === cursor) break;
      cursor = previous;
    }
    path.reverse();

    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);

    push('augment-path', {
      detail: 'Flip the augmenting path: the new row joins the matched set and one more column becomes covered.',
      path,
      targetRow: i - 1,
      targetRowLabel: workRowLabels[i - 1],
      matchedCount: i,
      matrix: cloneMatrix(work),
      rowLabels: workRowLabels.slice(),
      colLabels: workColLabels.slice(),
    });
  }

  const workAssignment = Array(n).fill(-1);
  const pairs = [];
  for (let j = 1; j <= m; j += 1) {
    if (p[j] !== 0) {
      const row = p[j] - 1;
      const col = j - 1;
      workAssignment[row] = col;
      pairs.push({ row, col, rowLabel: workRowLabels[row], colLabel: workColLabels[col] });
    }
  }
  pairs.sort((a, b) => a.row - b.row);

  const totalCost = pairs.reduce((sum, pair) => sum + work[pair.row][pair.col], 0);
  const assignment = transposed
    ? mapTransposedAssignment(workAssignment, initialRows, initialCols)
    : workAssignment;
  const finalPairs = [];
  for (let r = 0; r < initialRows; r += 1) {
    if (assignment[r] >= 0) {
      finalPairs.push({ row: r, col: assignment[r], rowLabel: rowLabels[r], colLabel: colLabels[assignment[r]] });
    }
  }

  push('final-assignment', {
    detail: `Matched ${finalPairs.length} of ${Math.min(initialRows, initialCols)} possible pairs at total cost ${formatNumber(totalCost)}.`,
    pairs: finalPairs,
    assignment: assignment.slice(),
    totalCost,
    matrix,
    rowLabels,
    colLabels,
  });

  return {
    assignment,
    totalCost,
    steps,
    matchedCount: finalPairs.length,
    rowLabels,
    colLabels,
    orientation: transposed ? 'transposed' : 'normal',
    matrix,
  };
}

function mapTransposedAssignment(workAssignment, rows, cols) {
  const assignment = Array(rows).fill(-1);
  for (let col = 0; col < cols; col += 1) {
    const row = workAssignment[col];
    if (row >= 0) assignment[row] = col;
  }
  return assignment;
}

function transpose(matrix) {
  const rows = matrix.length;
  const cols = matrix[0].length;
  const result = Array.from({ length: cols }, () => new Array(rows));
  for (let i = 0; i < rows; i += 1) {
    for (let j = 0; j < cols; j += 1) {
      result[j][i] = matrix[i][j];
    }
  }
  return result;
}

function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

const STEP_TITLES = {
  'row-reduction': 'Row reduction',
  'col-reduction': 'Column reduction',
  'star-zeros': 'Star independent zeros',
  'cover-cols': 'Cover matched columns',
  'augment-path': 'Augment the matching',
  'final-assignment': 'Final assignment',
};

export default hungarian;
