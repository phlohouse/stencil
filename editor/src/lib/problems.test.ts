import { describe, expect, it } from 'vitest';
import { findSchemaProblems, parseFieldRef } from './problems';
import type { StencilField, StencilVersion } from './types';

function version(discriminatorValue: string, fields: StencilField[]): StencilVersion {
  return { discriminatorValue, fields, validation: {} };
}

describe('parseFieldRef', () => {
  it('parses cells, bounded ranges and open-ended ranges', () => {
    expect(parseFieldRef('B2', 'Sheet1')).toMatchObject({
      sheetName: 'Sheet1', startRow: 1, endRow: 1, startCol: 1, endCol: 1,
    });
    expect(parseFieldRef('A1:C3', 'Sheet1')).toMatchObject({
      startRow: 0, endRow: 2, startCol: 0, endCol: 2,
    });
    expect(parseFieldRef('Sheet2!D5:D', 'Sheet1')).toMatchObject({
      sheetName: 'Sheet2', startRow: 4, startCol: 3, endCol: 3,
    });
  });
});

describe('findSchemaProblems', () => {
  it('reports fields that map overlapping cells', () => {
    const problems = findSchemaProblems(
      [
        { name: 'report_id', cell: 'B2' },
        { name: 'table', range: 'A1:C', type: 'table' },
      ],
      [version('v1.0', [])],
      'v1.0',
      'Sheet1',
    );

    expect(problems.map((problem) => problem.kind)).toContain('overlap');
    expect(problems[0].fieldNames).toEqual(['report_id', 'table']);
  });

  it('does not report fields on different sheets or disjoint ranges', () => {
    const problems = findSchemaProblems(
      [
        { name: 'a', cell: 'B2' },
        { name: 'b', cell: 'Sheet2!B2' },
        { name: 'c', cell: 'D9' },
        { name: 'computed', computed: '{a} + 1' },
      ],
      [version('v1.0', [])],
      'v1.0',
      'Sheet1',
    );

    expect(problems).toEqual([]);
  });

  it('reports table columns outside the range', () => {
    const problems = findSchemaProblems(
      [
        {
          name: 'results',
          range: 'A1:B',
          type: 'table',
          columns: { A: 'analyte', C: 'unit' },
        },
      ],
      [version('v1.0', [])],
      'v1.0',
      'Sheet1',
    );

    expect(problems).toHaveLength(1);
    expect(problems[0].kind).toBe('table-columns');
    expect(problems[0].message).toContain('C');
  });

  it('reports table rows outside a vertical table range', () => {
    const problems = findSchemaProblems(
      [
        {
          name: 'matrix',
          range: 'A3:C9',
          type: 'table',
          tableOrientation: 'vertical',
          columns: { '3': 'record_name', '10': 'extra' },
        },
      ],
      [version('v1.0', [])],
      'v1.0',
      'Sheet1',
    );

    expect(problems.map((problem) => problem.kind)).toContain('table-columns');
  });

  it('reports empty and repeated discriminator values', () => {
    const problems = findSchemaProblems(
      [],
      [version('', []), version('v1.0', []), version('v1.0', [])],
      '',
      'Sheet1',
    );

    const messages = problems.map((problem) => problem.message);
    expect(messages.some((message) => message.includes('no discriminator value'))).toBe(true);
    expect(messages.some((message) => message.includes('2 versions use'))).toBe(true);
    expect(messages.some((message) => message.includes('several versions are defined'))).toBe(true);
  });
});
