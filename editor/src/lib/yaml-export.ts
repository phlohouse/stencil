import jsYaml from 'js-yaml';
import type { StencilSchema, StencilField, StencilValidation } from './types';

interface YamlFieldOutput {
  cell?: string;
  range?: string;
  type?: string;
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
  discriminator: { cell: string };
  versions: Record<string, YamlVersionOutput>;
}

function buildFieldOutput(field: StencilField): YamlFieldOutput {
  const out: YamlFieldOutput = {};
  if (field.cell) out.cell = field.cell;
  if (field.range) out.range = field.range;
  if (field.type && field.type !== 'str') out.type = field.type;
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
  const output: YamlOutput = {
    name: schema.name || 'untitled',
    description: schema.description || '',
    discriminator: { cell: schema.discriminator.cell || 'A1' },
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
