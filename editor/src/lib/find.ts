/**
 * Text search over a sheet, used by the grid's find bar.
 *
 * Matching is a plain case-insensitive substring test on the cell's displayed
 * text, which is what a reader sees in the grid. Results come back in
 * row-major order so "next" walks the sheet the way it is laid out.
 */
import type { CellValue, SheetData } from './excel';

export interface FindMatch {
  col: number;
  row: number;
  /** The cell's text, for the result summary. */
  text: string;
}

/** Highlighting every match in a huge sheet costs more than it is worth. */
export const MAX_FIND_MATCHES = 2000;

export function cellText(value: CellValue | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

export function findMatches(
  sheetData: SheetData,
  query: string,
  options: { matchCase?: boolean } = {},
): FindMatch[] {
  const needle = options.matchCase ? query : query.toLowerCase();
  if (!needle) return [];

  const matches: FindMatch[] = [];
  const lastRow = Math.min(sheetData.rows, sheetData.data.length);
  for (let row = 0; row < lastRow; row += 1) {
    const rowData = sheetData.data[row];
    if (!rowData) continue;
    const lastCol = Math.min(sheetData.cols, rowData.length);
    for (let col = 0; col < lastCol; col += 1) {
      const text = cellText(rowData[col]);
      if (!text) continue;
      const haystack = options.matchCase ? text : text.toLowerCase();
      if (!haystack.includes(needle)) continue;
      matches.push({ col, row, text });
      if (matches.length >= MAX_FIND_MATCHES) return matches;
    }
  }
  return matches;
}

/** Wrap an index into ``count`` results, so next/previous loop around. */
export function stepMatchIndex(current: number, count: number, direction: 1 | -1): number {
  if (count <= 0) return 0;
  return ((current + direction) % count + count) % count;
}

export function findMatchKey(match: FindMatch): string {
  return `${match.row}:${match.col}`;
}
