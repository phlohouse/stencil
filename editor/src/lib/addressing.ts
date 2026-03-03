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
    if (start.col === end.col) {
      return `${startRef}:${colIndexToLetter(end.col)}`;
    }
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
