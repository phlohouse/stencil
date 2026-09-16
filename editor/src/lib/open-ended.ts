import type { SheetData } from './excel';

export const DEFAULT_BLANK_ROWS = 1;

/** Coerce a stored blank-row tolerance into a usable value. */
export function normalizeBlankRows(value: number | undefined | null): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return DEFAULT_BLANK_ROWS;
  }
  return Math.floor(value);
}

export interface OpenEndedRangeOptions {
  startRow: number;
  startCol: number;
  endCol: number;
  /** Consecutive blank rows that end the range (default 1). */
  blankRows?: number;
  /** Last row index to consider (inclusive); defaults to the whole sheet. */
  maxRow?: number;
}

/**
 * Last row of an open-ended range, matching how stencilpy reads it: the range
 * ends after `blankRows` consecutive fully blank rows, and shorter runs of blank
 * rows are skipped rather than included.
 *
 * Returns `startRow - 1` when the range holds no data at all.
 */
export function resolveOpenEndedEndRow(
  sheetData: SheetData,
  options: OpenEndedRangeOptions,
): number {
  const { startRow, startCol, endCol } = options;
  const tolerance = normalizeBlankRows(options.blankRows);
  const sheetLastRow = Math.max(0, sheetData.rows - 1);
  const lastRow = Math.min(options.maxRow ?? sheetLastRow, sheetLastRow);

  let endRow = startRow - 1;
  let blankStreak = 0;

  for (let row = startRow; row <= lastRow; row += 1) {
    let allBlank = true;
    for (let col = startCol; col <= endCol; col += 1) {
      const value = sheetData.cells[row]?.[col]?.value ?? null;
      if (value !== null && value !== '') {
        allBlank = false;
        break;
      }
    }

    if (allBlank) {
      blankStreak += 1;
      if (blankStreak >= tolerance) break;
      continue;
    }

    blankStreak = 0;
    endRow = row;
  }

  return endRow;
}
