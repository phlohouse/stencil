import type { CellAddress } from './types';

export function colIndexToLetter(index: number): string {
  let result = '';
  let i = index;
  while (i >= 0) {
    result = String.fromCharCode((i % 26) + 65) + result;
    i = Math.floor(i / 26) - 1;
  }
  return result;
}

export function letterToColIndex(letters: string): number {
  let result = 0;
  for (let i = 0; i < letters.length; i++) {
    result = result * 26 + (letters.charCodeAt(i) - 64);
  }
  return result - 1;
}

export function formatCellRef(col: number, row: number): string {
  return `${colIndexToLetter(col)}${row + 1}`;
}

export function formatAddress(addr: CellAddress): string {
  return formatCellRef(addr.col, addr.row);
}

export function formatRange(
  start: CellAddress,
  end: CellAddress,
  openEnded?: boolean,
): string {
  const startRef = formatAddress(start);
  if (start.col === end.col && start.row === end.row) {
    return startRef;
  }
  if (openEnded) {
    // Open-ended ranges read until the first empty row, so only the column
    // extent is meaningful in the reference itself.
    return `${startRef}:${colIndexToLetter(end.col)}`;
  }
  return `${startRef}:${formatAddress(end)}`;
}

export function formatSheetRef(
  sheet: string,
  ref: string,
  defaultSheet: string,
): string {
  if (sheet === defaultSheet) return ref;
  return `${sheet}!${ref}`;
}

export function parseAddress(ref: string): CellAddress {
  const match = ref.match(/^([A-Z]+)(\d+)$/);
  if (!match) throw new Error(`Invalid cell reference: ${ref}`);
  return {
    col: letterToColIndex(match[1]),
    row: parseInt(match[2], 10) - 1,
  };
}

export function isRangeSelection(start: CellAddress, end: CellAddress): boolean {
  return start.col !== end.col || start.row !== end.row;
}

/** Whether a range reference is open-ended, e.g. `D5:D` or `Sheet2!A1:D`. */
export function isOpenEndedRange(ref: string): boolean {
  const bare = ref.includes('!') ? ref.slice(ref.indexOf('!') + 1) : ref;
  return /^[A-Z]+\d+:[A-Z]+$/i.test(bare);
}

export function normalizeRange(
  start: CellAddress,
  end: CellAddress,
): { start: CellAddress; end: CellAddress } {
  return {
    start: {
      col: Math.min(start.col, end.col),
      row: Math.min(start.row, end.row),
    },
    end: {
      col: Math.max(start.col, end.col),
      row: Math.max(start.row, end.row),
    },
  };
}

export interface GridBounds {
  /** Inclusive index of the last addressable column. */
  maxCol: number;
  /** Inclusive index of the last addressable row. */
  maxRow: number;
}

export function clampCell(cell: CellAddress, bounds: GridBounds): CellAddress {
  return {
    col: Math.max(0, Math.min(cell.col, bounds.maxCol)),
    row: Math.max(0, Math.min(cell.row, bounds.maxRow)),
  };
}

export function rangesEqual(a: CellAddress, b: CellAddress): boolean {
  return a.col === b.col && a.row === b.row;
}

/**
 * Shift a region by (dc, dr), clamping the delta so the region stays inside the
 * grid instead of rejecting the move outright.
 */
export function clampRegionShift(
  region: { start: CellAddress; end: CellAddress },
  dc: number,
  dr: number,
  bounds: GridBounds,
): { start: CellAddress; end: CellAddress } {
  const width = region.end.col - region.start.col;
  const height = region.end.row - region.start.row;
  const clampedDc = Math.max(-region.start.col, Math.min(dc, bounds.maxCol - width - region.start.col));
  const clampedDr = Math.max(-region.start.row, Math.min(dr, bounds.maxRow - height - region.start.row));

  return {
    start: { col: region.start.col + clampedDc, row: region.start.row + clampedDr },
    end: { col: region.end.col + clampedDc, row: region.end.row + clampedDr },
  };
}

/** Same column/row extent, regardless of position. */
export function sameRangeShape(
  a: { start: CellAddress; end: CellAddress },
  b: { start: CellAddress; end: CellAddress },
): boolean {
  return a.end.col - a.start.col === b.end.col - b.start.col
    && a.end.row - a.start.row === b.end.row - b.start.row;
}

export function shiftColumnKey(key: string, delta: number): string | null {
  if (!/^[A-Z]+$/.test(key)) return null;
  const next = letterToColIndex(key) + delta;
  return next >= 0 ? colIndexToLetter(next) : null;
}

export function shiftRowKey(key: string, delta: number): string | null {
  if (!/^\d+$/.test(key)) return null;
  const next = parseInt(key, 10) + delta;
  return next >= 1 ? String(next) : null;
}
