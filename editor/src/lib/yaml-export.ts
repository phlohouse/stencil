import jsYaml from 'js-yaml';
import { isOpenEndedRange } from './addressing';
import type { StencilSchema, StencilField, StencilValidation, StencilVersion } from './types';

function createVersionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `version-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

interface YamlFieldOutput {
  cell?: string;
  range?: string;
  type?: string;
  orientation?: 'horizontal' | 'vertical' | 'grid';
  computed?: string;
  columns?: Record<string, string>;
  blank_rows?: number;
}

interface YamlVersionOutput {
  extends?: string;
  fields: Record<string, YamlFieldOutput>;
  validation?: Record<string, Partial<StencilValidation>>;
}

interface YamlOutput {
  name: string;
  description: string;
  discriminator: { cell?: string; cells?: string[] };
  versions: Record<string, YamlVersionOutput>;
}

function buildFieldOutput(field: StencilField): YamlFieldOutput {
  const out: YamlFieldOutput = {};
  if (field.cell) out.cell = field.cell;
  if (field.range) out.range = field.range;
  if (field.type && field.type !== 'str') out.type = field.type;
  if (field.type === 'table' && field.tableOrientation && field.tableOrientation !== 'horizontal') {
    out.orientation = field.tableOrientation;
  }
  if (field.listOrientation === 'grid' && (!field.type || field.type.startsWith('list['))) {
    out.orientation = 'grid';
  }
  if (field.computed) out.computed = field.computed;
  if (field.columns && Object.keys(field.columns).length > 0) {
    out.columns = field.columns;
  }
  // Only meaningful for open-ended ranges, and only when it differs from the
  // default of stopping at the first blank row.
  if (field.openEnded && field.range && typeof field.blankRows === 'number' && field.blankRows > 1) {
    out.blank_rows = field.blankRows;
  }
  return out;
}

function buildValidationOutput(
  validation: Record<string, StencilValidation>,
): Record<string, Partial<StencilValidation>> | undefined {
  const entries = Object.entries(validation).filter(([, v]) => {
    return v.min != null || v.max != null || v.pattern != null || v.required != null;
  });
  if (entries.length === 0) return undefined;

  const out: Record<string, Partial<StencilValidation>> = {};
  for (const [name, v] of entries) {
    const rule: Partial<StencilValidation> = {};
    if (v.min != null) rule.min = v.min;
    if (v.max != null) rule.max = v.max;
    if (v.pattern) rule.pattern = v.pattern;
    if (v.required != null) rule.required = v.required;
    out[name] = rule;
  }
  return out;
}

export function schemaToYaml(schema: StencilSchema): string {
  const discriminatorCells = (
    schema.discriminator.cells?.filter(Boolean).length
      ? schema.discriminator.cells?.filter(Boolean)
      : (schema.discriminator.cell ? [schema.discriminator.cell] : [])
  ) ?? [];
  const output: YamlOutput = {
    name: schema.name || 'untitled',
    description: schema.description || '',
    discriminator: {
      cells: discriminatorCells,
    },
    versions: {},
  };

  for (const version of schema.versions) {
    const fields: Record<string, YamlFieldOutput> = {};
    for (const field of version.fields) {
      fields[field.name] = buildFieldOutput(field);
    }

    const versionOutput: YamlVersionOutput = { fields };
    const validationOutput = buildValidationOutput(version.validation);
    if (validationOutput) {
      versionOutput.validation = validationOutput;
    }

    output.versions[version.discriminatorValue] = versionOutput;
  }

  return jsYaml.dump(output, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
    quotingType: '"',
    forceQuotes: false,
  });
}

export function parseYaml(yamlString: string): StencilSchema {
  const raw = jsYaml.load(yamlString) as YamlOutput;

  const definitions = raw.versions ?? {};
  const resolved = new Map<string, YamlVersionOutput>();
  const visiting = new Set<string>();
  const resolve = (key: string): YamlVersionOutput => {
    const cached = resolved.get(key);
    if (cached) return cached;
    if (visiting.has(key)) throw new Error(`Circular version inheritance: ${key}`);
    if (!Object.hasOwn(definitions, key)) throw new Error(`Unknown parent version: ${key}`);
    const definition = definitions[key];
    visiting.add(key);
    const parent = definition.extends != null ? resolve(String(definition.extends)) : null;
    const validation = { ...parent?.validation };
    for (const name of Object.keys(definition.fields ?? {})) {
      delete validation[name];
      if (definition.validation?.[name]) validation[name] = definition.validation[name];
    }
    const merged = {
      fields: { ...parent?.fields, ...definition.fields },
      validation,
    };
    visiting.delete(key);
    resolved.set(key, merged);
    return merged;
  };
  const versions: StencilVersion[] = Object.entries(definitions).map(
    ([discriminatorValue]) => {
      const versionData = resolve(discriminatorValue);
      const fields: StencilField[] = Object.entries(versionData.fields ?? {}).map(
        ([name, fieldData]) => {
          const field: StencilField = { name };
          if (fieldData.cell) field.cell = fieldData.cell;
          if (fieldData.range) {
            field.range = fieldData.range;
            if (isOpenEndedRange(fieldData.range)) {
              field.openEnded = true;
            }
          }
          if (fieldData.type) field.type = fieldData.type;
          if (fieldData.orientation === 'grid') field.listOrientation = 'grid';
          else if (fieldData.orientation) field.tableOrientation = fieldData.orientation;
          if (fieldData.computed) field.computed = fieldData.computed;
          if (fieldData.columns) field.columns = fieldData.columns;
          if (typeof fieldData.blank_rows === 'number' && fieldData.blank_rows > 1) {
            field.blankRows = fieldData.blank_rows;
          }
          return field;
        },
      );

      const validation: Record<string, StencilValidation> = {};
      if (versionData.validation) {
        for (const [fieldName, rules] of Object.entries(versionData.validation)) {
          validation[fieldName] = { ...rules } as StencilValidation;
        }
      }

      return { id: createVersionId(), discriminatorValue, fields, validation };
    },
  );

  return {
    name: raw.name || '',
    description: raw.description || '',
    discriminator: {
      cell: raw.discriminator?.cells?.filter(Boolean)?.[0] || raw.discriminator?.cell || '',
      cells: raw.discriminator?.cells?.filter(Boolean)
        ?? (raw.discriminator?.cell ? [raw.discriminator.cell] : []),
    },
    versions: versions.length ? versions : [{ id: createVersionId(), discriminatorValue: 'v1.0', fields: [], validation: {} }],
  };
}

export function downloadYaml(schema: StencilSchema, filename?: string): void {
  const yaml = schemaToYaml(schema);
  const blob = new Blob([yaml], { type: 'text/yaml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename ?? `${schema.name || 'schema'}.stencil.yaml`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
