import { describe, expect, it } from 'vitest';
import {
  clampCell,
  clampRegionShift,
  colIndexToLetter,
  formatAddress,
  formatRange,
  isRangeSelection,
  letterToColIndex,
  normalizeRange,
  parseAddress,
  sameRangeShape,
  shiftColumnKey,
  shiftRowKey,
} from './addressing';

describe('column letters', () => {
  it('converts indices to letters', () => {
    expect(colIndexToLetter(0)).toBe('A');
    expect(colIndexToLetter(25)).toBe('Z');
    expect(colIndexToLetter(26)).toBe('AA');
    expect(colIndexToLetter(51)).toBe('AZ');
    expect(colIndexToLetter(52)).toBe('BA');
    expect(colIndexToLetter(701)).toBe('ZZ');
    expect(colIndexToLetter(702)).toBe('AAA');
  });

  it('round-trips letters back to indices', () => {
    for (const index of [0, 1, 25, 26, 51, 52, 700, 701, 702, 16383]) {
      expect(letterToColIndex(colIndexToLetter(index))).toBe(index);
    }
  });

  it('parses and formats cell addresses', () => {
    expect(parseAddress('A1')).toEqual({ col: 0, row: 0 });
    expect(parseAddress('AA12')).toEqual({ col: 26, row: 11 });
    expect(formatAddress({ col: 26, row: 11 })).toBe('AA12');
  });

  it('rejects invalid addresses', () => {
    expect(() => parseAddress('A')).toThrow();
    expect(() => parseAddress('1A')).toThrow();
    expect(() => parseAddress('A1:B2')).toThrow();
  });
});

describe('normalizeRange', () => {
  it('orders the corners', () => {
    expect(normalizeRange({ col: 3, row: 5 }, { col: 1, row: 2 })).toEqual({
      start: { col: 1, row: 2 },
      end: { col: 3, row: 5 },
    });
  });

  it('detects single-cell selections', () => {
    expect(isRangeSelection({ col: 1, row: 1 }, { col: 1, row: 1 })).toBe(false);
    expect(isRangeSelection({ col: 1, row: 1 }, { col: 2, row: 1 })).toBe(true);
  });
});

describe('formatRange', () => {
  it('formats a single cell without a colon', () => {
    expect(formatRange({ col: 1, row: 2 }, { col: 1, row: 2 })).toBe('B3');
  });

  it('formats a bounded range', () => {
    expect(formatRange({ col: 0, row: 0 }, { col: 3, row: 49 })).toBe('A1:D50');
  });

  it('formats an open-ended range without an end row', () => {
    expect(formatRange({ col: 3, row: 4 }, { col: 3, row: 40 }, true)).toBe('D5:D');
    expect(formatRange({ col: 0, row: 0 }, { col: 3, row: 40 }, true)).toBe('A1:D');
  });
});

describe('clampRegionShift', () => {
  const bounds = { maxCol: 9, maxRow: 19 };

  it('shifts a region when it fits', () => {
    const region = { start: { col: 1, row: 1 }, end: { col: 3, row: 4 } };
    expect(clampRegionShift(region, 2, 3, bounds)).toEqual({
      start: { col: 3, row: 4 },
      end: { col: 5, row: 7 },
    });
  });

  it('clamps at the left and top edges', () => {
    const region = { start: { col: 1, row: 2 }, end: { col: 3, row: 4 } };
    expect(clampRegionShift(region, -5, -9, bounds)).toEqual({
      start: { col: 0, row: 0 },
      end: { col: 2, row: 2 },
    });
  });

  it('clamps at the right and bottom edges without resizing', () => {
    const region = { start: { col: 1, row: 1 }, end: { col: 3, row: 4 } };
    const shifted = clampRegionShift(region, 50, 50, bounds);
    expect(shifted).toEqual({
      start: { col: 7, row: 16 },
      end: { col: 9, row: 19 },
    });
    expect(sameRangeShape(region, shifted)).toBe(true);
  });

  it('never moves a region that already fills the grid', () => {
    const region = { start: { col: 0, row: 0 }, end: { col: 9, row: 19 } };
    expect(clampRegionShift(region, 4, 4, bounds)).toEqual(region);
  });
});

describe('sameRangeShape', () => {
  it('compares extents only', () => {
    expect(sameRangeShape(
      { start: { col: 0, row: 0 }, end: { col: 2, row: 2 } },
      { start: { col: 5, row: 5 }, end: { col: 7, row: 7 } },
    )).toBe(true);
    expect(sameRangeShape(
      { start: { col: 0, row: 0 }, end: { col: 2, row: 2 } },
      { start: { col: 0, row: 0 }, end: { col: 3, row: 2 } },
    )).toBe(false);
  });
});

describe('clampCell', () => {
  it('keeps a cell inside the grid', () => {
    const bounds = { maxCol: 4, maxRow: 9 };
    expect(clampCell({ col: -3, row: -1 }, bounds)).toEqual({ col: 0, row: 0 });
    expect(clampCell({ col: 40, row: 90 }, bounds)).toEqual({ col: 4, row: 9 });
    expect(clampCell({ col: 2, row: 3 }, bounds)).toEqual({ col: 2, row: 3 });
  });
});

describe('mapping key shifts', () => {
  it('shifts column letters', () => {
    expect(shiftColumnKey('A', 2)).toBe('C');
    expect(shiftColumnKey('D', -2)).toBe('B');
    expect(shiftColumnKey('A', -1)).toBeNull();
    expect(shiftColumnKey('3', 1)).toBeNull();
  });

  it('shifts row numbers', () => {
    expect(shiftRowKey('3', 2)).toBe('5');
    expect(shiftRowKey('4', -3)).toBe('1');
    expect(shiftRowKey('1', -1)).toBeNull();
    expect(shiftRowKey('B', 1)).toBeNull();
  });
});
