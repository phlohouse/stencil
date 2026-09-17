import { describe, expect, it } from 'vitest';
import { diffFields, diffValidation, diffVersions } from './schema-diff';
import type { StencilField, StencilVersion } from './types';

function version(
  discriminatorValue: string,
  fields: StencilField[],
  validation: StencilVersion['validation'] = {},
): StencilVersion {
  return { discriminatorValue, fields, validation };
}

describe('diffFields', () => {
  it('reports nothing for identical fields', () => {
    expect(diffFields({ name: 'a', cell: 'B2' }, { name: 'a', cell: 'B2' })).toEqual([]);
  });

  it('describes mapping, type and column changes', () => {
    const changes = diffFields(
      { name: 'a', cell: 'B2', type: 'str' },
      { name: 'a', range: 'A1:C', type: 'table', columns: { A: 'name' } },
    );
    expect(changes[0]).toBe('mapping cell B2 → range A1:C');
    expect(changes[1]).toBe('type str → table');
    expect(changes).toContain('columns none → A→name');
  });

  it('treats unset type and orientation as their defaults', () => {
    expect(diffFields({ name: 'a', cell: 'B2' }, { name: 'a', cell: 'B2', type: undefined })).toEqual([]);
    expect(
      diffFields(
        { name: 't', range: 'A1:C', type: 'table' },
        { name: 't', range: 'A1:C', type: 'table', tableOrientation: 'horizontal' },
      ),
    ).toEqual([]);
  });

  it('notices blank row and open-ended changes', () => {
    const changes = diffFields(
      { name: 'r', range: 'D5:D', openEnded: true, blankRows: 1 },
      { name: 'r', range: 'D5:D', openEnded: false, blankRows: 2 },
    );
    expect(changes).toContain('blank rows 1 → 2');
    expect(changes).toContain('open ended yes → no');
  });
});

describe('diffValidation', () => {
  it('reports added, removed and changed rules', () => {
    const diffs = diffValidation(
      { keep: { min: 0 }, drop: { required: true }, edit: { max: 5 } },
      { keep: { min: 0 }, edit: { max: 9 }, add: { pattern: '^A' } },
    );
    expect(diffs.map((diff) => `${diff.status}:${diff.field}`)).toEqual([
      'added:add',
      'removed:drop',
      'changed:edit',
    ]);
    expect(diffs[2].changes).toEqual(['max 5 → 9']);
  });

  it('ignores versions without rules', () => {
    expect(diffValidation({}, {})).toEqual([]);
  });
});

describe('diffVersions', () => {
  it('summarises what changed between two versions', () => {
    const diff = diffVersions(
      version('v1.0', [{ name: 'shared', cell: 'B2' }, { name: 'gone', cell: 'B3' }], {
        shared: { required: true },
      }),
      version('v2.0', [{ name: 'shared', cell: 'B2', type: 'str' }, { name: 'fresh', cell: 'C3' }]),
    );

    expect(diff.from).toBe('v1.0');
    expect(diff.to).toBe('v2.0');
    expect(diff.discriminatorChanged).toBe(true);
    expect(diff.summary).toEqual({ added: 1, removed: 1, changed: 0 });
    expect(diff.fields.map((field) => `${field.status}:${field.name}`)).toEqual([
      'added:fresh',
      'removed:gone',
      'unchanged:shared',
    ]);
    expect(diff.validation).toEqual([
      { field: 'shared', status: 'removed', changes: ['required'] },
    ]);
  });

  it('reports changed fields with their differences', () => {
    const diff = diffVersions(
      version('v1', [{ name: 'readings', range: 'D5:D', type: 'list[str]' }]),
      version('v2', [{ name: 'readings', range: 'D5:D', type: 'list[float]' }]),
    );
    expect(diff.summary).toEqual({ added: 0, removed: 0, changed: 1 });
    expect(diff.fields[0].changes).toEqual(['type list[str] → list[float]']);
  });

  it('reports no differences for the same version', () => {
    const same = version('v1', [{ name: 'a', cell: 'B2' }]);
    const diff = diffVersions(same, same);
    expect(diff.discriminatorChanged).toBe(false);
    expect(diff.summary).toEqual({ added: 0, removed: 0, changed: 0 });
    expect(diff.fields).toEqual([{ name: 'a', status: 'unchanged', changes: [] }]);
  });
});
