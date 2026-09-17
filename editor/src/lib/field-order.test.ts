import { describe, expect, it } from 'vitest';
import { moveFieldInList, nextFieldName, nextVersionKey } from './field-order';
import type { StencilField } from './types';

const fields: StencilField[] = [
  { name: 'a', cell: 'A1' },
  { name: 'b', cell: 'B1' },
  { name: 'c', cell: 'C1' },
];

describe('moveFieldInList', () => {
  it('moves a field up and down', () => {
    expect(moveFieldInList(fields, 'b', -1).map((field) => field.name)).toEqual(['b', 'a', 'c']);
    expect(moveFieldInList(fields, 'b', 1).map((field) => field.name)).toEqual(['a', 'c', 'b']);
  });

  it('clamps at the ends and ignores unknown fields', () => {
    expect(moveFieldInList(fields, 'a', -1).map((field) => field.name)).toEqual(['a', 'b', 'c']);
    expect(moveFieldInList(fields, 'c', 5).map((field) => field.name)).toEqual(['a', 'b', 'c']);
    expect(moveFieldInList(fields, 'missing', 1)).toBe(fields);
  });
});

describe('names', () => {
  it('suffixes a duplicate field name', () => {
    expect(nextFieldName(fields, 'a')).toBe('a_2');
    expect(nextFieldName([...fields, { name: 'a_2' }], 'a')).toBe('a_3');
    expect(nextFieldName(fields, 'z')).toBe('z');
  });

  it('suffixes a duplicate version key and falls back when empty', () => {
    expect(nextVersionKey(['v1.0'], 'v1.0')).toBe('v1.0_2');
    expect(nextVersionKey(['v1.0', 'v1.0_2'], 'v1.0')).toBe('v1.0_3');
    expect(nextVersionKey([], '   ')).toBe('v1.0');
  });
});
