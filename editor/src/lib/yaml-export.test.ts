import { describe, expect, it } from 'vitest';
import { parseYaml, schemaToYaml } from './yaml-export';
import type { StencilSchema } from './types';

const schema: StencilSchema = {
  name: 'lab_report',
  description: 'Monthly lab report',
  discriminator: { cell: 'A1', cells: ['A1'] },
  versions: [
    {
      id: 'v2',
      discriminatorValue: 'v2.0',
      validation: {},
      fields: [
        { name: 'patient_name', cell: 'B3' },
        { name: 'readings', range: 'D5:D', type: 'list[float]', openEnded: true },
        {
          name: 'results_table',
          range: 'A20:D',
          type: 'table',
          openEnded: true,
          blankRows: 2,
          columns: { A: 'analyte', B: 'value', C: 'unit', D: 'flag' },
        },
      ],
    },
  ],
};

describe('schemaToYaml', () => {
  it('emits blank_rows only for open-ended ranges that need it', () => {
    const yaml = schemaToYaml(schema);
    expect(yaml).toContain('blank_rows: 2');
    // The plain open-ended list keeps the default tolerance out of the file.
    const readingsBlock = yaml.slice(yaml.indexOf('readings:'), yaml.indexOf('results_table:'));
    expect(readingsBlock).not.toContain('blank_rows');
  });

  it('does not emit blank_rows for bounded ranges', () => {
    const bounded = schemaToYaml({
      ...schema,
      versions: [{
        ...schema.versions[0],
        fields: [{ name: 'readings', range: 'D5:D20', type: 'list[float]', blankRows: 3 }],
      }],
    });
    expect(bounded).not.toContain('blank_rows');
  });
});

describe('parseYaml', () => {
  it('infers openEnded from the reference syntax', () => {
    const parsed = parseYaml(schemaToYaml(schema));
    const fields = parsed.versions[0].fields;
    expect(fields.find((f) => f.name === 'readings')?.openEnded).toBe(true);
    expect(fields.find((f) => f.name === 'patient_name')?.openEnded).toBeUndefined();
  });

  it('reads blank_rows back', () => {
    const parsed = parseYaml(schemaToYaml(schema));
    const table = parsed.versions[0].fields.find((f) => f.name === 'results_table');
    expect(table?.blankRows).toBe(2);
    expect(table?.columns).toEqual({ A: 'analyte', B: 'value', C: 'unit', D: 'flag' });
  });

  it('round-trips a schema without losing field metadata', () => {
    const parsed = parseYaml(schemaToYaml(schema));
    const again = schemaToYaml({ ...parsed, versions: parsed.versions });
    expect(again).toBe(schemaToYaml(schema));
  });
});
