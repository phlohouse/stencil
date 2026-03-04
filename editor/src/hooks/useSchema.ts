import { useState, useCallback, useEffect } from 'react';
import type {
  StencilSchema,
  StencilField,
  StencilValidation,
  StencilVersion,
} from '../lib/types';

const STORAGE_KEY = 'stencil-editor-schema';

function createDefaultVersion(): StencilVersion {
  return {
    discriminatorValue: 'v1.0',
    fields: [],
    validation: {},
  };
}

function createDefaultSchema(): StencilSchema {
  return {
    name: '',
    description: '',
    discriminator: { cell: '' },
    versions: [createDefaultVersion()],
  };
}

function loadFromStorage(): StencilSchema {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as StencilSchema;
      if (parsed.versions?.length) return parsed;
    }
  } catch { /* ignore corrupt data */ }
  return createDefaultSchema();
}

export function useSchema() {
  const [schema, setSchema] = useState<StencilSchema>(loadFromStorage);
  const [activeVersionIndex, setActiveVersionIndex] = useState(0);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(schema));
  }, [schema]);

  const activeVersion = schema.versions[activeVersionIndex] as StencilVersion | undefined;

  const setName = useCallback((name: string) => {
    setSchema((s) => ({ ...s, name }));
  }, []);

  const setDescription = useCallback((description: string) => {
    setSchema((s) => ({ ...s, description }));
  }, []);

  const setDiscriminator = useCallback((cell: string) => {
    setSchema((s) => ({ ...s, discriminator: { cell } }));
  }, []);

  const updateVersion = useCallback(
    (updater: (v: StencilVersion) => StencilVersion) => {
      setSchema((s) => {
        const versions = [...s.versions];
        const current = versions[activeVersionIndex];
        if (current) {
          versions[activeVersionIndex] = updater(current);
        }
        return { ...s, versions };
      });
    },
    [activeVersionIndex],
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

  const addVersion = useCallback(
    (discriminatorValue: string, copyFromIndex?: number) => {
      setSchema((s) => {
        const source =
          copyFromIndex != null && copyFromIndex >= 0 && copyFromIndex < s.versions.length
            ? s.versions[copyFromIndex]
            : null;
        const nextVersion: StencilVersion = source
          ? {
              discriminatorValue,
              fields: source.fields.map((field) => ({ ...field })),
              validation: JSON.parse(JSON.stringify(source.validation)) as Record<string, StencilValidation>,
            }
          : { discriminatorValue, fields: [], validation: {} };

        return {
          ...s,
          versions: [...s.versions, nextVersion],
        };
      });
      setActiveVersionIndex(schema.versions.length);
    },
    [schema.versions.length],
  );

  const removeVersion = useCallback(
    (index: number) => {
      setSchema((s) => {
        if (s.versions.length <= 1) return s;
        const versions = s.versions.filter((_, i) => i !== index);
        return { ...s, versions };
      });
      setActiveVersionIndex((i) => (i >= schema.versions.length - 1 ? Math.max(0, i - 1) : i));
    },
    [schema.versions.length],
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
    setSchema(newSchema);
    setActiveVersionIndex(0);
  }, []);

  const resetSchema = useCallback(() => {
    setSchema(createDefaultSchema());
    setActiveVersionIndex(0);
  }, []);

  return {
    schema,
    activeVersion,
    activeVersionIndex,
    setActiveVersionIndex,
    setName,
    setDescription,
    setDiscriminator,
    addField,
    removeField,
    updateField,
    addVersion,
    removeVersion,
    setVersionDiscriminatorValue,
    setValidation,
    removeValidation,
    loadSchema,
    resetSchema,
  };
}
