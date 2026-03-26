import jsYaml from 'js-yaml';
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
  orientation?: 'horizontal' | 'vertical';
  computed?: string;
  columns?: Record<string, string>;
}

interface YamlVersionOutput {
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
  if (field.computed) out.computed = field.computed;
  if (field.columns && Object.keys(field.columns).length > 0) {
    out.columns = field.columns;
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

  const versions: StencilVersion[] = Object.entries(raw.versions ?? {}).map(
    ([discriminatorValue, versionData]) => {
      const fields: StencilField[] = Object.entries(versionData.fields ?? {}).map(
        ([name, fieldData]) => {
          const field: StencilField = { name };
          if (fieldData.cell) field.cell = fieldData.cell;
          if (fieldData.range) field.range = fieldData.range;
          if (fieldData.type) field.type = fieldData.type;
          if (fieldData.orientation) field.tableOrientation = fieldData.orientation;
          if (fieldData.computed) field.computed = fieldData.computed;
          if (fieldData.columns) field.columns = fieldData.columns;
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
