import { useState, useCallback, useEffect, useRef } from 'react';
import type {
  StencilSchema,
  StencilField,
  StencilValidation,
  StencilVersion,
} from '../lib/types';
import type { Workbook } from '../lib/excel';
import { createHistory, recordChange, redoStep, undoStep, type History } from '../lib/history';
import { moveFieldInList, nextFieldName } from '../lib/field-order';
import {
  captureFingerprints as captureFieldFingerprints,
  getFingerprints,
  findRemappings,
  type RemapSuggestion,
} from '../lib/field-fingerprints';

const STORAGE_KEY = 'stencil-editor-schema';

function createVersionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `version-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function createDefaultVersion(): StencilVersion {
  return {
    id: createVersionId(),
    discriminatorValue: 'v1.0',
    fields: [],
    validation: {},
  };
}

function createDefaultSchema(): StencilSchema {
  return {
    name: '',
    description: '',
    discriminator: { cell: '', cells: [] },
    versions: [createDefaultVersion()],
  };
}

function loadFromStorage(): StencilSchema {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as StencilSchema;
      if (parsed.versions?.length) {
        return {
          ...parsed,
          versions: parsed.versions.map((version) => ({
            ...version,
            id: version.id || createVersionId(),
          })),
        };
      }
    }
  } catch { /* ignore corrupt data */ }
  return createDefaultSchema();
}

export function useSchema() {
  const [schema, setSchema] = useState<StencilSchema>(loadFromStorage);
  const [history, setHistory] = useState<History<StencilSchema>>(() => createHistory());
  const [activeVersionIndex, setActiveVersionIndex] = useState(0);

  // The schema is replaced wholesale on every change, so the current value is kept
  // in a ref: history bookkeeping then happens outside a state updater, which keeps
  // it correct under StrictMode's double invocation.
  const schemaRef = useRef(schema);
  const historyRef = useRef(history);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(schema));
  }, [schema]);

  /** Apply a change and record the previous schema for undo. */
  const commit = useCallback((updater: (previous: StencilSchema) => StencilSchema) => {
    const previous = schemaRef.current;
    const next = updater(previous);
    if (next === previous) return;

    schemaRef.current = next;
    const nextHistory = recordChange(historyRef.current, previous);
    historyRef.current = nextHistory;
    setSchema(next);
    setHistory(nextHistory);
  }, []);

  const undo = useCallback(() => {
    const step = undoStep(historyRef.current, schemaRef.current);
    if (!step) return;

    schemaRef.current = step.state;
    historyRef.current = step.history;
    setSchema(step.state);
    setHistory(step.history);
  }, []);

  const redo = useCallback(() => {
    const step = redoStep(historyRef.current, schemaRef.current);
    if (!step) return;

    schemaRef.current = step.state;
    historyRef.current = step.history;
    setSchema(step.state);
    setHistory(step.history);
  }, []);

  // Undo can remove versions, so the index is clamped before it is used.
  const activeIndex = Math.min(activeVersionIndex, Math.max(0, schema.versions.length - 1));
  const activeVersion = schema.versions[activeIndex] as StencilVersion | undefined;

  const setName = useCallback((name: string) => {
    commit((s) => ({ ...s, name }));
  }, [commit]);

  const setDescription = useCallback((description: string) => {
    commit((s) => ({ ...s, description }));
  }, [commit]);

  const setDiscriminator = useCallback((cell: string) => {
    commit((s) => {
      const existing = s.discriminator.cells?.length
        ? s.discriminator.cells
        : (s.discriminator.cell ? [s.discriminator.cell] : []);

      const deduped = existing.includes(cell) ? existing : [...existing, cell];
      const primary = deduped[0] ?? cell;

      return {
        ...s,
        discriminator: {
          cell: primary,
          cells: deduped,
        },
      };
    });
  }, [commit]);

  const removeDiscriminator = useCallback((cell: string) => {
    commit((s) => {
      const existing = s.discriminator.cells?.length
        ? s.discriminator.cells
        : (s.discriminator.cell ? [s.discriminator.cell] : []);

      const remaining = existing.filter((entry) => entry !== cell);

      return {
        ...s,
        discriminator: {
          cell: remaining[0] ?? '',
          cells: remaining,
        },
      };
    });
  }, [commit]);

  const clearDiscriminators = useCallback(() => {
    commit((s) => ({
      ...s,
      discriminator: {
        cell: '',
        cells: [],
      },
    }));
  }, [commit]);

  const updateVersion = useCallback(
    (updater: (v: StencilVersion) => StencilVersion) => {
      commit((s) => {
        const versions = [...s.versions];
        const current = versions[activeIndex];
        if (current) {
          versions[activeIndex] = updater(current);
        }
        return { ...s, versions };
      });
    },
    [activeIndex, commit],
  );

  const addField = useCallback(
    (field: StencilField) => {
      updateVersion((v) => ({
        ...v,
        fields: [...v.fields, field],
      }));
    },
    [updateVersion],
  );

  const removeField = useCallback(
    (fieldName: string) => {
      updateVersion((v) => ({
        ...v,
        fields: v.fields.filter((f) => f.name !== fieldName),
        validation: (() => {
          const val = { ...v.validation };
          delete val[fieldName];
          return val;
        })(),
      }));
    },
    [updateVersion],
  );

  const updateField = useCallback(
    (fieldName: string, updates: Partial<StencilField>) => {
      updateVersion((v) => ({
        ...v,
        fields: v.fields.map((f) =>
          f.name === fieldName ? { ...f, ...updates } : f,
        ),
      }));
    },
    [updateVersion],
  );

  /** Move a field up or down in the version's field order. */
  const moveField = useCallback(
    (fieldName: string, delta: number) => {
      updateVersion((v) => ({ ...v, fields: moveFieldInList(v.fields, fieldName, delta) }));
    },
    [updateVersion],
  );

  /** Copy a field and insert it after the original, with a free name. */
  const duplicateField = useCallback(
    (fieldName: string) => {
      updateVersion((v) => {
        const index = v.fields.findIndex((field) => field.name === fieldName);
        if (index < 0) return v;

        const source = v.fields[index];
        const copy: StencilField = {
          ...source,
          name: nextFieldName(v.fields, fieldName),
          columns: source.columns ? { ...source.columns } : undefined,
        };

        const fields = [...v.fields];
        fields.splice(index + 1, 0, copy);
        return { ...v, fields };
      });
    },
    [updateVersion],
  );

  /**
   * Replace a field wholesale. Unlike `updateField` this cannot leave stale
   * properties behind (e.g. `columns` surviving a switch away from `table`).
   */
  const replaceField = useCallback(
    (fieldName: string, field: StencilField) => {
      updateVersion((v) => ({
        ...v,
        fields: v.fields.map((f) => (f.name === fieldName ? field : f)),
      }));
    },
    [updateVersion],
  );

  const addVersion = useCallback(
    (discriminatorValue: string, copyFromIndex?: number) => {
      const newVersionId = createVersionId();
      commit((s) => {
        const source =
          copyFromIndex != null && copyFromIndex >= 0 && copyFromIndex < s.versions.length
            ? s.versions[copyFromIndex]
            : null;
        const nextVersion: StencilVersion = source
          ? {
              id: newVersionId,
              discriminatorValue,
              fields: source.fields.map((field) => ({ ...field })),
              validation: JSON.parse(JSON.stringify(source.validation)) as Record<string, StencilValidation>,
            }
          : { id: newVersionId, discriminatorValue, fields: [], validation: {} };

        return {
          ...s,
          versions: [...s.versions, nextVersion],
        };
      });
      setActiveVersionIndex(schema.versions.length);
      return newVersionId;
    },
    [commit, schema.versions.length],
  );

  const removeVersion = useCallback(
    (index: number) => {
      commit((s) => {
        if (s.versions.length <= 1) return s;
        const versions = s.versions.filter((_, i) => i !== index);
        return { ...s, versions };
      });
      setActiveVersionIndex((i) => (i >= schema.versions.length - 1 ? Math.max(0, i - 1) : i));
    },
    [commit, schema.versions.length],
  );

  const setVersionDiscriminatorValue = useCallback(
    (value: string) => {
      updateVersion((v) => ({ ...v, discriminatorValue: value }));
    },
    [updateVersion],
  );

  const setValidation = useCallback(
    (fieldName: string, validation: StencilValidation) => {
      updateVersion((v) => ({
        ...v,
        validation: { ...v.validation, [fieldName]: validation },
      }));
    },
    [updateVersion],
  );

  const removeValidation = useCallback(
    (fieldName: string) => {
      updateVersion((v) => {
        const validation = { ...v.validation };
        delete validation[fieldName];
        return { ...v, validation };
      });
    },
    [updateVersion],
  );

  const loadSchema = useCallback((newSchema: StencilSchema) => {
    commit(() => newSchema);
    setActiveVersionIndex(0);
  }, [commit]);

  const resetSchema = useCallback(() => {
    commit(() => createDefaultSchema());
    setActiveVersionIndex(0);
  }, [commit]);

  const captureFingerprints = useCallback(
    (workbook: Workbook) => {
      const version = schema.versions[activeIndex];
      if (!version) {
        console.log('[fingerprint] no version at index', activeIndex);
        return;
      }
      const name = schema.name || '_untitled';
      console.log('[fingerprint] capturing for', name, version.discriminatorValue, 'fields:', version.fields.length);
      captureFieldFingerprints(
        name,
        version.discriminatorValue,
        version.fields,
        workbook,
      );
      const stored = getFingerprints(name, version.discriminatorValue);
      console.log('[fingerprint] stored', stored.length, 'fingerprints:', stored.map((f) => `${f.fieldName}=${f.sampleValues[0]}`));
    },
    [activeIndex, schema.name, schema.versions],
  );

  const suggestRemappings = useCallback(
    (sourceDiscriminatorValue: string, workbook: Workbook, fields?: StencilField[]): RemapSuggestion[] => {
      const name = schema.name || '_untitled';
      const fps = getFingerprints(name, sourceDiscriminatorValue);
      console.log('[remap] looking up fingerprints for', name, sourceDiscriminatorValue, '→', fps.length, 'found');
      if (fps.length === 0) return [];
      const targetFields = fields ?? schema.versions[activeIndex]?.fields;
      if (!targetFields) {
        console.log('[remap] no target fields');
        return [];
      }
      console.log('[remap] searching for remappings across', targetFields.length, 'fields');
      const results = findRemappings(fps, workbook, targetFields);
      console.log('[remap] found', results.length, 'suggestions:', results.map((r) => `${r.fieldName}: ${r.oldRef}→${r.newRef} (${Math.round(r.confidence * 100)}%)`));
      return results;
    },
    [activeIndex, schema.name, schema.versions],
  );

  return {
    schema,
    activeVersion,
    activeVersionIndex: activeIndex,
    undo,
    redo,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    setActiveVersionIndex,
    setName,
    setDescription,
    setDiscriminator,
    removeDiscriminator,
    clearDiscriminators,
    addField,
    removeField,
    updateField,
    replaceField,
    moveField,
    duplicateField,
    addVersion,
    removeVersion,
    setVersionDiscriminatorValue,
    setValidation,
    removeValidation,
    loadSchema,
    resetSchema,
    captureFingerprints,
    suggestRemappings,
  };
}
