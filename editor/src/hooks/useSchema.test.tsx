// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useSchema } from './useSchema';
import type { StencilField, StencilSchema } from '../lib/types';

const STORAGE_KEY = 'stencil-editor-schema';

function field(name: string, cell = 'B2'): StencilField {
  return { name, cell };
}

function schemaWith(versions: StencilSchema['versions']): StencilSchema {
  return {
    name: 'report',
    description: '',
    discriminator: { cell: 'A1', cells: ['A1'] },
    versions,
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe('useSchema history', () => {
  it('starts with one version and nothing to undo', () => {
    const { result } = renderHook(() => useSchema());
    expect(result.current.schema.versions).toHaveLength(1);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  it('undoes and redoes a schema change', () => {
    const { result } = renderHook(() => useSchema());

    act(() => result.current.setName('lab_report'));
    expect(result.current.schema.name).toBe('lab_report');
    expect(result.current.canUndo).toBe(true);

    act(() => result.current.undo());
    expect(result.current.schema.name).toBe('');
    expect(result.current.canRedo).toBe(true);

    act(() => result.current.redo());
    expect(result.current.schema.name).toBe('lab_report');
    expect(result.current.canRedo).toBe(false);
  });

  it('undoes field edits one step at a time', () => {
    const { result } = renderHook(() => useSchema());

    act(() => result.current.addField(field('patient_name')));
    act(() => result.current.addField(field('lab_id', 'B10')));
    expect(result.current.activeVersion?.fields).toHaveLength(2);

    act(() => result.current.undo());
    expect(result.current.activeVersion?.fields.map((f) => f.name)).toEqual(['patient_name']);

    act(() => result.current.undo());
    expect(result.current.activeVersion?.fields).toHaveLength(0);
  });

  it('does not record a no-op change', () => {
    const { result } = renderHook(() => useSchema());

    act(() => result.current.removeField('missing'));
    expect(result.current.canUndo).toBe(false);
  });

  it('loads a schema and clears the active version', () => {
    const { result } = renderHook(() => useSchema());

    act(() => result.current.addVersion('v2.0'));
    expect(result.current.activeVersionIndex).toBe(1);

    act(() =>
      result.current.loadSchema(
        schemaWith([
          { id: 'a', discriminatorValue: 'v1.0', fields: [field('a')], validation: {} },
        ]),
      ),
    );
    expect(result.current.activeVersionIndex).toBe(0);
    expect(result.current.activeVersion?.discriminatorValue).toBe('v1.0');
  });
});

describe('useSchema version index', () => {
  it('clamps the active index when a version is removed', () => {
    const { result } = renderHook(() => useSchema());

    act(() => result.current.addVersion('v2.0'));
    act(() => result.current.addVersion('v3.0'));
    expect(result.current.schema.versions).toHaveLength(3);

    act(() => result.current.setActiveVersionIndex(2));
    expect(result.current.activeVersionIndex).toBe(2);

    act(() => result.current.removeVersion(2));
    expect(result.current.schema.versions).toHaveLength(2);
    expect(result.current.activeVersionIndex).toBe(1);
    expect(result.current.activeVersion?.discriminatorValue).toBe('v2.0');
  });

  it('clamps the active index after an undo removes the last version', () => {
    const { result } = renderHook(() => useSchema());

    act(() => result.current.addVersion('v2.0'));
    act(() => result.current.setActiveVersionIndex(1));
    expect(result.current.activeVersion?.discriminatorValue).toBe('v2.0');

    act(() => result.current.undo());
    expect(result.current.schema.versions).toHaveLength(1);
    // The index still points past the end, so reads must clamp.
    expect(result.current.activeVersionIndex).toBe(0);
    expect(result.current.activeVersion?.discriminatorValue).toBe('v1.0');
  });

  it('keeps the last version when asked to remove it', () => {
    const { result } = renderHook(() => useSchema());

    act(() => result.current.removeVersion(0));
    expect(result.current.schema.versions).toHaveLength(1);
  });

  it('adds a version by copying the current fields and selects it', () => {
    const { result } = renderHook(() => useSchema());

    act(() => result.current.addField(field('patient_name')));
    act(() => result.current.addVersion('v2.0', 0));

    expect(result.current.activeVersionIndex).toBe(1);
    expect(result.current.activeVersion?.fields.map((f) => f.name)).toEqual(['patient_name']);
    expect(result.current.activeVersion?.id).not.toBe(result.current.schema.versions[0].id);
  });
});

describe('useSchema field tools', () => {
  it('duplicates a field with a free name right after it', () => {
    const { result } = renderHook(() => useSchema());

    act(() => result.current.addField(field('readings')));
    act(() => result.current.duplicateField('readings'));

    const names = result.current.activeVersion?.fields.map((f) => f.name) ?? [];
    expect(names).toHaveLength(2);
    expect(names[0]).toBe('readings');
    expect(names[1]).not.toBe('readings');
  });

  it('moves a field up and down the list', () => {
    const { result } = renderHook(() => useSchema());

    act(() => result.current.addField(field('a')));
    act(() => result.current.addField(field('b')));

    act(() => result.current.moveField('b', -1));
    expect(result.current.activeVersion?.fields.map((f) => f.name)).toEqual(['b', 'a']);

    act(() => result.current.moveField('b', 1));
    expect(result.current.activeVersion?.fields.map((f) => f.name)).toEqual(['a', 'b']);
  });

  it('drops validation rules with the field they belong to', () => {
    const { result } = renderHook(() => useSchema());

    act(() => result.current.addField(field('readings')));
    act(() => result.current.setValidation('readings', { min: 0, max: 10 }));
    expect(result.current.activeVersion?.validation.readings).toEqual({ min: 0, max: 10 });

    act(() => result.current.removeField('readings'));
    expect(result.current.activeVersion?.validation.readings).toBeUndefined();
  });

  it('persists the schema to local storage', () => {
    const { result } = renderHook(() => useSchema());

    act(() => result.current.setName('lab_report'));
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}').name).toBe('lab_report');
  });
});
