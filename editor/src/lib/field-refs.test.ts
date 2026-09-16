import { describe, expect, it } from 'vitest';
import {
  applySelectionToField,
  filterMappingKeysToRange,
  isTypeCompatibleWithShape,
  shiftMappingKeys,
  typeForShape,
} from './field-refs';
import type { Selection, StencilField } from './types';

const cell = (col: number, row: number): Selection => ({
  start: { col, row },
  end: { col, row },
});

const range = (startCol: number, startRow: number, endCol: number, endRow: number): Selection => ({
  start: { col: startCol, row: startRow },
  end: { col: endCol, row: endRow },
});

const ctx = { sheetName: 'Sheet1', defaultSheet: 'Sheet1' };

describe('typeForShape', () => {
  it('maps scalar types onto ranges', () => {
    expect(typeForShape('int', true)).toBe('list[int]');
    expect(typeForShape('float', true)).toBe('list[float]');
    expect(typeForShape('bool', true)).toBe('list[bool]');
    expect(typeForShape('str', true)).toBe('list[str]');
    expect(typeForShape(undefined, true)).toBe('list[str]');
  });

  it('maps range types onto cells', () => {
    expect(typeForShape('list[str]', false)).toBe('str');
    expect(typeForShape('list[float]', false)).toBe('float');
    expect(typeForShape('list[int]', false)).toBe('int');
    expect(typeForShape('dict[str, str]', false)).toBe('str');
    expect(typeForShape('table', false)).toBe('str');
  });

  it('leaves compatible types alone', () => {
    expect(typeForShape('table', true)).toBe('table');
    expect(typeForShape('list[bool]', true)).toBe('list[bool]');
    expect(typeForShape('datetime', false)).toBe('datetime');
    expect(typeForShape('str', false)).toBe('str');
  });
});

describe('isTypeCompatibleWithShape', () => {
  it('accepts scalars for cells and range types for ranges', () => {
    expect(isTypeCompatibleWithShape('str', false)).toBe(true);
    expect(isTypeCompatibleWithShape('datetime', false)).toBe(true);
    expect(isTypeCompatibleWithShape('list[str]', true)).toBe(true);
    expect(isTypeCompatibleWithShape('table', true)).toBe(true);
  });

  it('rejects mismatches', () => {
    expect(isTypeCompatibleWithShape('str', true)).toBe(false);
    expect(isTypeCompatibleWithShape('list[str]', false)).toBe(false);
    expect(isTypeCompatibleWithShape('table', false)).toBe(false);
  });
});

describe('shiftMappingKeys', () => {
  it('shifts column letters and row numbers on their own axis', () => {
    expect(shiftMappingKeys({ A: 'analyte', B: 'value' }, 2, 5))
      .toEqual({ C: 'analyte', D: 'value' });
    expect(shiftMappingKeys({ '3': 'weight', '4': 'height' }, -5, 1))
      .toEqual({ '4': 'weight', '5': 'height' });
  });

  it('drops keys that would move outside the sheet', () => {
    expect(shiftMappingKeys({ A: 'first', B: 'second' }, -1, 0)).toEqual({ A: 'second' });
    expect(shiftMappingKeys({ '1': 'first' }, 0, -1)).toEqual({});
  });
});

describe('filterMappingKeysToRange', () => {
  it('keeps only keys inside the range', () => {
    expect(filterMappingKeysToRange({ A: 'a', B: 'b', D: 'd', E: 'e' }, range(1, 0, 3, 0)))
      .toEqual({ B: 'b', D: 'd' });
  });

  it('filters row-numbered mappings', () => {
    expect(filterMappingKeysToRange({ '3': 'x', '5': 'y', '9': 'z' }, range(0, 4, 3, 6)))
      .toEqual({ '5': 'y' });
  });
});

describe('applySelectionToField', () => {
  it('turns a cell field into a range field', () => {
    const field: StencilField = { name: 'patient', cell: 'B3', type: 'str' };
    const next = applySelectionToField(field, range(1, 2, 1, 4), ctx);
    expect(next).toEqual({
      name: 'patient',
      type: 'list[str]',
      cell: undefined,
      range: 'B3:B5',
      openEnded: undefined,
      tableOrientation: undefined,
      columns: undefined,
    });
  });

  it('turns a range field back into a cell field', () => {
    const field: StencilField = {
      name: 'readings',
      range: 'D5:D',
      type: 'list[float]',
      openEnded: true,
    };
    const next = applySelectionToField(field, cell(3, 4), ctx);
    expect(next).toEqual({
      name: 'readings',
      type: 'float',
      cell: 'D5',
      range: undefined,
      openEnded: undefined,
      tableOrientation: undefined,
      columns: undefined,
    });
  });

  it('keeps the open-ended marker and sheet prefix when moving', () => {
    const field: StencilField = { name: 'readings', range: 'D5:D', type: 'list[float]', openEnded: true };
    const next = applySelectionToField(field, range(5, 5, 5, 20), {
      sheetName: 'Sheet2',
      defaultSheet: 'Sheet1',
      sourceRange: range(3, 4, 3, 20),
    });
    expect(next.range).toBe('Sheet2!F6:F');
    expect(next.openEnded).toBe(true);
  });

  it('shifts table column mappings when the range moves', () => {
    const field: StencilField = {
      name: 'results',
      range: 'A6:D',
      type: 'table',
      openEnded: true,
      columns: { A: 'analyte', B: 'value', C: 'unit', D: 'flag' },
    };
    const next = applySelectionToField(field, range(1, 5, 4, 20), {
      ...ctx,
      sourceRange: range(0, 5, 3, 20),
    });
    expect(next.range).toBe('B6:E');
    expect(next.columns).toEqual({ B: 'analyte', C: 'value', D: 'unit', E: 'flag' });
  });

  it('drops mappings when the range shape changes', () => {
    const field: StencilField = {
      name: 'results',
      range: 'A6:D',
      type: 'table',
      openEnded: true,
      columns: { A: 'analyte', B: 'value' },
    };
    const next = applySelectionToField(field, range(0, 5, 1, 20), {
      ...ctx,
      sourceRange: range(0, 5, 3, 20),
    });
    expect(next.columns).toBeUndefined();
  });

  it('shifts vertical table row mappings when the range moves', () => {
    const field: StencilField = {
      name: 'meta',
      range: 'A6:B',
      type: 'table',
      openEnded: true,
      tableOrientation: 'vertical',
      columns: { '6': 'weight', '7': 'height' },
    };
    const next = applySelectionToField(field, range(0, 8, 1, 23), {
      ...ctx,
      sourceRange: range(0, 5, 1, 20),
    });
    expect(next.columns).toEqual({ '9': 'weight', '10': 'height' });
  });

  it('never leaves range metadata on a cell field', () => {
    const field: StencilField = {
      name: 'mixed',
      range: 'A1:B2',
      type: 'table',
      openEnded: true,
      tableOrientation: 'vertical',
      columns: { A: 'x' },
    };
    const next = applySelectionToField(field, cell(0, 0), ctx);
    expect(next.cell).toBe('A1');
    expect(next.range).toBeUndefined();
    expect(next.openEnded).toBeUndefined();
    expect(next.tableOrientation).toBeUndefined();
    expect(next.columns).toBeUndefined();
  });
});
