/**
 * Exact O(n^3) Hungarian (Munkres / Jonker-Volgenant) bipartite matcher.
 *
 * Solves the rectangular assignment problem: given an n x m cost matrix,
 * choose a maximum-cardinality set of row/column pairs with minimum total
 * cost. Rows typically represent volunteer capacity slots, columns represent
 * community requests. There are no dependencies and no global state.
 *
 * The implementation uses potentials with augmenting paths (the O(n^3)
 * shortest-augmenting-path form). The dual potentials are seeded with the
 * classical row/column reductions, a standard Jonker-Volgenant
 * initialization, so the reduced-cost matrix the trace displays is the
 * solver's own state `work[i][j] - u[i] - v[j]` at each recorded instant.
 *
 * Every step snapshot is emitted in the ORIGINAL (input) orientation so a
 * UI can render one stable frame: when the solver internally transposes a
 * tall matrix, matrices, paths, covered sets and labels are transposed
 * back for display, and each step records the matching `potentials`
 * ({rows, cols}) so `matrix[i][j] = input[i][j] - rows[i] - cols[j]` can be
 * verified cell by cell.
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
 * Maximum-cardinality matching on the zero cells of a reduced matrix
 * (Kuhn's augmenting algorithm). Returns `matchCol[j] = row` or -1.
 * This is the genuine Munkres "independent zeros" quantity, not a greedy
 * first-fit pass.
 */
function maxZeroMatching(matrix, rows, cols) {
  const matchCol = new Array(cols).fill(-1);
  const seen = new Uint8Array(cols);
  const visit = (row) => {
    for (let j = 0; j < cols; j += 1) {
      if (matrix[row][j] !== 0 || seen[j]) continue;
      seen[j] = 1;
      if (matchCol[j] === -1 || visit(matchCol[j])) {
        matchCol[j] = row;
        return true;
      }
    }
    return false;
  };
  for (let i = 0; i < rows; i += 1) {
    seen.fill(0);
    visit(i);
  }
  return matchCol;
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
        potentials: { rows: [], cols: [] },
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

  // Display helpers. Every snapshot is emitted in the input orientation so
  // a UI draws one stable frame; when the solver works on the transpose,
  // positions, covered sets and potentials swap back for display.
  const displayLabels = () => ({ rowLabels: rowLabels.slice(), colLabels: colLabels.slice() });
  const displayMatrix = (workMatrix) => (transposed ? transpose(workMatrix) : cloneMatrix(workMatrix));
  const displayCell = (cell) => (transposed
    ? { row: cell.col, col: cell.row, rowLabel: cell.colLabel, colLabel: cell.rowLabel }
    : cell);
  const displayCovered = (workCols) => (transposed ? { coveredRows: workCols } : { coveredCols: workCols });
  const displayExplored = (workCols) => (transposed ? { exploredRows: workCols } : { exploredColumns: workCols });
  const displayTarget = (workRow) => ({
    target: { dim: transposed ? 'col' : 'row', index: workRow, label: workRowLabels[workRow] },
  });
  // Map the solver's dual potentials into the display frame: for a
  // transposed solve the work-row potential u becomes a display-column
  // potential and the work-column potential v a display-row potential.
  const snapshotPotentials = () => {
    const rows = new Array(transposed ? m : n);
    const cols = new Array(transposed ? n : m);
    if (transposed) {
      for (let i = 0; i < m; i += 1) rows[i] = v[i + 1];
      for (let j = 0; j < n; j += 1) cols[j] = u[j + 1];
    } else {
      for (let i = 0; i < n; i += 1) rows[i] = u[i + 1];
      for (let j = 0; j < m; j += 1) cols[j] = v[j + 1];
    }
    return { rows, cols };
  };
  // Map a pair of work-frame potential vectors into the display frame.
  const mapPotentials = (workU, workV) => (transposed
    ? { rows: workV.slice(), cols: workU.slice() }
    : { rows: workU.slice(), cols: workV.slice() });
  // Classical reduction duals: the potentials implied by the row and/or
  // column minima actually subtracted for the displayed matrix.
  const reductionPots = (rowsDone, colsDone) => mapPotentials(
    rowMins.map((x) => (rowsDone ? x : 0)),
    colMins.map((x) => (colsDone ? x : 0)),
  );
  // The solver's reduced-cost matrix at the current potentials, snapped to
  // kill float noise on exact zeros.
  const reducedMatrix = () => {
    const out = Array.from({ length: n }, () => new Array(m));
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < m; j += 1) {
        const value = work[i][j] - u[i + 1] - v[j + 1];
        out[i][j] = Math.abs(value) < 1e-9 ? 0 : Math.round(value * 1e9) / 1e9;
      }
    }
    return out;
  };

  // Row/column reductions. They also seed the dual potentials below, so the
  // displayed matrices are literally the solver's initial reduced costs.
  const rowMins = work.map((row) => Math.min(...row));
  const afterRows = work.map((row, i) => row.map((value) => value - rowMins[i]));
  const colMins = Array.from({ length: m }, (_, j) => Math.min(...afterRows.map((row) => row[j])));
  const afterCols = afterRows.map((row) => row.map((value, j) => value - colMins[j]));

  // Potentials based augmenting path solver. u[i] / v[j] are the dual
  // potentials, p[j] = row matched to column j (0 means unmatched), way[j]
  // tracks the predecessor column in the alternating tree. u is seeded with
  // the row reductions, a standard feasible dual start (seeding v as well
  // would make every reduced cost zero and break optimality).
  const u = new Float64Array(n + 1);
  const v = new Float64Array(m + 1);
  for (let i = 1; i <= n; i += 1) u[i] = rowMins[i - 1];
  const p = new Int32Array(m + 1);
  const way = new Int32Array(m + 1);

  // The first reduction the solver performs is a row reduction on the WORK
  // matrix; in the display (input) frame that is a column reduction when
  // the input was transposed, so the step is named by what the viewer sees.
  if (transposed) {
    push('col-reduction', {
      detail: 'Subtract the smallest cost in each column. A zero now marks the cheapest slot for that request.',
      reductions: colLabels.map((label, j) => ({ index: j, label, min: rowMins[j] })),
      matrix: transpose(afterRows),
      potentials: reductionPots(true, false),
      ...displayLabels(),
    });
    push('row-reduction', {
      detail: 'Subtract the smallest reduced cost in each row. Every slot keeps at least one zero and all costs stay nonnegative.',
      reductions: rowLabels.map((label, i) => ({ index: i, label, min: colMins[i] })),
      matrix: transpose(afterCols),
      potentials: reductionPots(true, true),
      ...displayLabels(),
    });
  } else {
    push('row-reduction', {
      detail: 'Subtract the smallest cost in each row. A zero now marks the cheapest request for that slot.',
      reductions: rowLabels.map((label, i) => ({ index: i, label, min: rowMins[i] })),
      matrix: cloneMatrix(afterRows),
      potentials: reductionPots(true, false),
      ...displayLabels(),
    });
    push('col-reduction', {
      detail: 'Subtract the smallest reduced cost in each column. Every request keeps at least one zero and all costs stay nonnegative.',
      reductions: colLabels.map((label, j) => ({ index: j, label, min: colMins[j] })),
      matrix: cloneMatrix(afterCols),
      potentials: reductionPots(true, true),
      ...displayLabels(),
    });
  }

  // Star the largest possible set of independent zeros: a maximum matching
  // on the zero graph of the reduced matrix, the genuine Munkres bound.
  const matchCol = maxZeroMatching(afterCols, n, m);
  const starred = [];
  for (let j = 0; j < m; j += 1) {
    if (matchCol[j] >= 0) {
      starred.push(displayCell({ row: matchCol[j], col: j, rowLabel: workRowLabels[matchCol[j]], colLabel: workColLabels[j] }));
    }
  }
  push('star-zeros', {
    detail: `Find the largest set of zeros sharing no row or column. ${starred.length} starred zero${starred.length === 1 ? '' : 's'} mark cost-free matches the reductions make possible.`,
    cells: starred,
    ...displayCovered([]),
    matrix: displayMatrix(afterCols),
    potentials: reductionPots(true, true),
    ...displayLabels(),
  });

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
      title: transposed ? 'Cover matched rows' : 'Cover matched columns',
      detail: 'Matches found so far are covered while the solver searches the alternating tree for the next cheapest connection.',
      ...displayCovered(covered),
      coveredLabels: covered.map((j) => workColLabels[j]),
      ...displayTarget(i - 1),
      ...displayExplored(visitedColumns.filter((j) => j > 0).map((j) => j - 1)),
      matrix: displayMatrix(reducedMatrix()),
      potentials: snapshotPotentials(),
      ...displayLabels(),
    });

    const path = [];
    let cursor = j0;
    while (cursor !== 0) {
      path.push(displayCell({ row: p[cursor] - 1, col: cursor - 1, rowLabel: workRowLabels[p[cursor] - 1], colLabel: workColLabels[cursor - 1] }));
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

    const coveredAfter = [];
    for (let j = 1; j <= m; j += 1) {
      if (p[j] !== 0) coveredAfter.push(j - 1);
    }
    push('augment-path', {
      detail: 'Flip the highlighted alternating path so one more match joins at the smallest possible added cost.',
      path,
      ...displayTarget(i - 1),
      matchedCount: i,
      ...displayCovered(coveredAfter),
      matrix: displayMatrix(reducedMatrix()),
      potentials: snapshotPotentials(),
      ...displayLabels(),
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
    potentials: { rows: new Array(initialRows).fill(0), cols: new Array(initialCols).fill(0) },
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
