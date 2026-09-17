import { describe, expect, it } from 'vitest';
import { MAX_FIND_MATCHES, cellText, findMatchKey, findMatches, stepMatchIndex } from './find';
import type { SheetData } from './excel';

function sheet(rows: (string | number | null)[][]): SheetData {
  return {
    name: 'Sheet1',
    data: rows,
    cells: rows.map((row) => row.map(() => ({}))),
    rows: rows.length,
    cols: Math.max(...rows.map((row) => row.length)),
    hiddenCols: [],
    colWidths: [],
  } as unknown as SheetData;
}

const sample = sheet([
  ['Patient', 'Reading', null],
  ['Jane Doe', 12, 'high'],
  ['John Doe', 3, 'low'],
]);

describe('cellText', () => {
  it('renders values and blanks', () => {
    expect(cellText('abc')).toBe('abc');
    expect(cellText(0)).toBe('0');
    expect(cellText(null)).toBe('');
    expect(cellText(undefined)).toBe('');
  });
});

describe('findMatches', () => {
  it('finds every case-insensitive substring in row-major order', () => {
    expect(findMatches(sample, 'doe')).toEqual([
      { col: 0, row: 1, text: 'Jane Doe' },
      { col: 0, row: 2, text: 'John Doe' },
    ]);
  });

  it('matches numbers and other cell types', () => {
    expect(findMatches(sample, '12')).toEqual([{ col: 1, row: 1, text: '12' }]);
  });

  it('can match case', () => {
    expect(findMatches(sample, 'doe', { matchCase: true })).toEqual([]);
    expect(findMatches(sample, 'Doe', { matchCase: true })).toHaveLength(2);
  });

  it('returns nothing for an empty query', () => {
    expect(findMatches(sample, '')).toEqual([]);
  });

  it('caps the number of matches', () => {
    const wide = sheet(Array.from({ length: 50 }, () => Array.from({ length: 50 }, () => 'x')));
    expect(findMatches(wide, 'x')).toHaveLength(MAX_FIND_MATCHES);
  });
});

describe('stepMatchIndex', () => {
  it('wraps around in both directions', () => {
    expect(stepMatchIndex(0, 3, 1)).toBe(1);
    expect(stepMatchIndex(2, 3, 1)).toBe(0);
    expect(stepMatchIndex(0, 3, -1)).toBe(2);
    expect(stepMatchIndex(0, 0, 1)).toBe(0);
  });
});

describe('findMatchKey', () => {
  it('identifies a cell', () => {
    expect(findMatchKey({ col: 2, row: 5, text: 'x' })).toBe('5:2');
  });
});
