import type { StencilField } from './types';

/** Move a field up or down in the list, keeping the others in order. */
export function moveFieldInList(
  fields: StencilField[],
  fieldName: string,
  delta: number,
): StencilField[] {
  const index = fields.findIndex((field) => field.name === fieldName);
  if (index < 0 || delta === 0) return fields;

  const target = Math.max(0, Math.min(fields.length - 1, index + delta));
  if (target === index) return fields;

  const next = [...fields];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved);
  return next;
}

/** `name` when it is free, otherwise `name_2`, `name_3`, … */
export function nextFreeName(existing: Iterable<string>, base: string): string {
  const taken = new Set(existing);
  if (!taken.has(base)) return base;

  let index = 2;
  while (taken.has(`${base}_${index}`)) index += 1;
  return `${base}_${index}`;
}

export function nextFieldName(fields: StencilField[], base: string): string {
  return nextFreeName(fields.map((field) => field.name), base);
}

export function nextVersionKey(values: Iterable<string>, base: string): string {
  const trimmed = base.trim() || 'v1.0';
  return nextFreeName(values, trimmed);
}
