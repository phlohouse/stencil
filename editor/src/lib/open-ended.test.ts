import { describe, expect, it } from 'vitest';
import { normalizeBlankRows, resolveOpenEndedEndRow } from './open-ended';
import type { CellInfo, SheetData } from './excel';

function sheet(rows: (string | number | null)[][]): SheetData {
  const data = rows.map((row) => row.slice());
  const cells: CellInfo[][] = data.map((row) => row.map((value) => ({ value })));
  return {
    name: 'Sheet1',
    data,
    cells,
    rows: data.length,
    cols: Math.max(0, ...data.map((row) => row.length)),
    hiddenCols: [],
    colWidths: [],
  };
}

describe('normalizeBlankRows', () => {
  it('falls back to one for missing or invalid values', () => {
    expect(normalizeBlankRows(undefined)).toBe(1);
    expect(normalizeBlankRows(0)).toBe(1);
    expect(normalizeBlankRows(-4)).toBe(1);
    expect(normalizeBlankRows(Number.NaN)).toBe(1);
  });

  it('keeps whole numbers', () => {
    expect(normalizeBlankRows(2)).toBe(2);
    expect(normalizeBlankRows(3.7)).toBe(3);
  });
});

describe('resolveOpenEndedEndRow', () => {
  const data = sheet([
    ['a'],      // row 0
    ['b'],      // row 1
    [null],     // row 2 — blank
    ['c'],      // row 3
    [null],     // row 4 — blank
    [null],     // row 5 — blank
    ['d'],      // row 6
  ]);

  it('stops at the first blank row by default', () => {
    expect(resolveOpenEndedEndRow(data, { startRow: 0, startCol: 0, endCol: 0 })).toBe(1);
  });

  it('skips a single blank row when the tolerance is two', () => {
    expect(resolveOpenEndedEndRow(data, { startRow: 0, startCol: 0, endCol: 0, blankRows: 2 }))
      .toBe(3);
  });

  it('reads across longer runs within the tolerance', () => {
    expect(resolveOpenEndedEndRow(data, { startRow: 0, startCol: 0, endCol: 0, blankRows: 3 }))
      .toBe(6);
  });

  it('returns startRow - 1 when the range is empty', () => {
    expect(resolveOpenEndedEndRow(data, { startRow: 2, startCol: 0, endCol: 0 })).toBe(1);
  });

  it('honours a maxRow bound', () => {
    expect(resolveOpenEndedEndRow(data, {
      startRow: 0, startCol: 0, endCol: 0, blankRows: 3, maxRow: 2,
    })).toBe(1);
  });

  it('treats empty strings as blank', () => {
    const withEmptyStrings = sheet([['a'], [''], ['b']]);
    expect(resolveOpenEndedEndRow(withEmptyStrings, { startRow: 0, startCol: 0, endCol: 0 }))
      .toBe(0);
  });

  it('requires every column of the row to be blank', () => {
    const multiColumn = sheet([
      ['a', 'b'],
      [null, 'x'],
      [null, null],
    ]);
    expect(resolveOpenEndedEndRow(multiColumn, { startRow: 0, startCol: 0, endCol: 1 })).toBe(1);
  });
});
