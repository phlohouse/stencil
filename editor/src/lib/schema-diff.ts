/**
 * Compare two versions of a schema, so a reader can see what changed between
 * (for example) the workbook layouts of v1 and v2 without diffing YAML by hand.
 */
import type { StencilField, StencilValidation, StencilVersion } from './types';

export type DiffStatus = 'added' | 'removed' | 'changed' | 'unchanged';

export interface FieldDiff {
  name: string;
  status: DiffStatus;
  /** Human-readable list of what differs, empty for added/removed/unchanged. */
  changes: string[];
}

export interface ValidationDiff {
  field: string;
  status: DiffStatus;
  changes: string[];
}

export interface VersionDiff {
  from: string;
  to: string;
  discriminatorChanged: boolean;
  fields: FieldDiff[];
  validation: ValidationDiff[];
  summary: { added: number; removed: number; changed: number };
}

function fieldLabel(field: StencilField): string {
  if (field.computed) return `computed "${field.computed}"`;
  if (field.cell) return `cell ${field.cell}`;
  if (field.range) return `range ${field.range}`;
  return 'no mapping';
}

/**
 * The type a field extracts as, mirroring stencilpy's defaults, so an explicit
 * `type: str` and an omitted type do not look like a change.
 */
export function effectiveType(field: StencilField): string {
  if (field.type) return field.type;
  if (field.computed) return 'any';
  if (field.cell) return 'str';
  if (field.range) return 'list[str]';
  return '';
}

function describeColumns(columns: Record<string, string> | undefined): string {
  const entries = Object.entries(columns ?? {});
  if (entries.length === 0) return 'none';
  return entries.map(([key, value]) => `${key}→${value}`).join(', ');
}

/** Compare the extractable parts of a field; order of the list is stable. */
export function diffFields(before: StencilField, after: StencilField): string[] {
  const changes: string[] = [];

  const beforeRef = before.computed ?? before.cell ?? before.range ?? '';
  const afterRef = after.computed ?? after.cell ?? after.range ?? '';
  if (beforeRef !== afterRef) {
    changes.push(`mapping ${fieldLabel(before)} → ${fieldLabel(after)}`);
  }
  if (effectiveType(before) !== effectiveType(after)) {
    changes.push(`type ${effectiveType(before) || 'none'} → ${effectiveType(after) || 'none'}`);
  }
  if ((before.tableOrientation ?? 'horizontal') !== (after.tableOrientation ?? 'horizontal')) {
    changes.push(
      `orientation ${before.tableOrientation ?? 'horizontal'} → ${after.tableOrientation ?? 'horizontal'}`,
    );
  }
  const beforeColumns = describeColumns(before.columns);
  const afterColumns = describeColumns(after.columns);
  if (beforeColumns !== afterColumns) {
    changes.push(`columns ${beforeColumns} → ${afterColumns}`);
  }
  if ((before.blankRows ?? 1) !== (after.blankRows ?? 1)) {
    changes.push(`blank rows ${before.blankRows ?? 1} → ${after.blankRows ?? 1}`);
  }
  if (Boolean(before.openEnded) !== Boolean(after.openEnded)) {
    changes.push(`open ended ${before.openEnded ? 'yes' : 'no'} → ${after.openEnded ? 'yes' : 'no'}`);
  }
  return changes;
}

function describeRule(rule: StencilValidation): string {
  const bits: string[] = [];
  if (rule.min != null) bits.push(`min ${rule.min}`);
  if (rule.max != null) bits.push(`max ${rule.max}`);
  if (rule.pattern != null) bits.push(`pattern ${rule.pattern}`);
  if (rule.required != null) bits.push(rule.required ? 'required' : 'optional');
  return bits.length > 0 ? bits.join(', ') : 'no rules';
}

export function diffValidation(
  before: Record<string, StencilValidation>,
  after: Record<string, StencilValidation>,
): ValidationDiff[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  const diffs: ValidationDiff[] = [];

  for (const name of [...names].sort()) {
    const beforeRule = before[name];
    const afterRule = after[name];
    if (!beforeRule && afterRule) {
      diffs.push({ field: name, status: 'added', changes: [describeRule(afterRule)] });
      continue;
    }
    if (beforeRule && !afterRule) {
      diffs.push({ field: name, status: 'removed', changes: [describeRule(beforeRule)] });
      continue;
    }
    if (!beforeRule || !afterRule) continue;

    const changes: string[] = [];
    for (const key of ['min', 'max', 'pattern', 'required'] as const) {
      const beforeValue = beforeRule[key];
      const afterValue = afterRule[key];
      if (beforeValue === afterValue) continue;
      changes.push(`${key} ${beforeValue ?? 'unset'} → ${afterValue ?? 'unset'}`);
    }
    if (changes.length > 0) {
      diffs.push({ field: name, status: 'changed', changes });
    }
  }
  return diffs;
}

export function diffVersions(before: StencilVersion, after: StencilVersion): VersionDiff {
  const beforeFields = new Map(before.fields.map((field) => [field.name, field]));
  const afterFields = new Map(after.fields.map((field) => [field.name, field]));

  const names = new Set([...beforeFields.keys(), ...afterFields.keys()]);
  const fields: FieldDiff[] = [];
  for (const name of [...names].sort()) {
    const beforeField = beforeFields.get(name);
    const afterField = afterFields.get(name);
    if (!beforeField && afterField) {
      fields.push({ name, status: 'added', changes: [fieldLabel(afterField)] });
      continue;
    }
    if (beforeField && !afterField) {
      fields.push({ name, status: 'removed', changes: [fieldLabel(beforeField)] });
      continue;
    }
    if (!beforeField || !afterField) continue;

    const changes = diffFields(beforeField, afterField);
    fields.push({ name, status: changes.length > 0 ? 'changed' : 'unchanged', changes });
  }

  return {
    from: before.discriminatorValue,
    to: after.discriminatorValue,
    discriminatorChanged: before.discriminatorValue !== after.discriminatorValue,
    fields,
    validation: diffValidation(before.validation, after.validation),
    summary: {
      added: fields.filter((field) => field.status === 'added').length,
      removed: fields.filter((field) => field.status === 'removed').length,
      changed: fields.filter((field) => field.status === 'changed').length,
    },
  };
}
