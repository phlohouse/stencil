import {
  formatAddress,
  formatRange,
  isRangeSelection,
  letterToColIndex,
  normalizeRange,
  sameRangeShape,
  shiftColumnKey,
  shiftRowKey,
} from './addressing';
import type { Selection, StencilField } from './types';

const SCALAR_TYPES = new Set(['str', 'int', 'float', 'bool', 'datetime', 'date']);

const LIST_TYPES = new Set(['list[str]', 'list[int]', 'list[float]', 'list[bool]']);

const DICT_TYPES = new Set(['dict', 'dict[str, str]', 'dict[str, int]', 'dict[str, float]']);

export function isScalarType(type: string | undefined): boolean {
  return !type || SCALAR_TYPES.has(type);
}

export function isRangeType(type: string | undefined): boolean {
  return Boolean(type) && (LIST_TYPES.has(type as string) || DICT_TYPES.has(type as string) || type === 'table');
}

export function defaultTypeForShape(isRange: boolean): string {
  return isRange ? 'list[str]' : 'str';
}

/**
 * Coerce a type into the equivalent type for the given reference shape, so a
 * field can never end up with a scalar type on a range (or vice versa).
 */
export function typeForShape(type: string | undefined, isRange: boolean): string {
  if (isRange) {
    if (isRangeType(type)) return type as string;
    if (type === 'int' || type === 'float' || type === 'bool') return `list[${type}]`;
    return 'list[str]';
  }

  if (LIST_TYPES.has(type ?? '')) return (type as string).slice(5, -1);
  if (DICT_TYPES.has(type ?? '') || type === 'table') return 'str';
  return type ?? 'str';
}

/** Whether a type can be stored against a cell/range reference of this shape. */
export function isTypeCompatibleWithShape(type: string | undefined, isRange: boolean): boolean {
  return isRange ? isRangeType(type) : isScalarType(type);
}

export interface FieldRefContext {
  sheetName: string;
  defaultSheet: string;
  /**
   * The region the field currently covers, as rendered. Required when the field
   * is being moved/resized so open-ended ranges and column mappings can be
   * updated correctly.
   */
  sourceRange?: Selection | null;
}

export function selectionToRef(
  selection: Selection,
  ctx: { sheetName: string; defaultSheet: string },
  openEnded = false,
): string {
  const normalized = normalizeRange(selection.start, selection.end);
  const isRange = isRangeSelection(normalized.start, normalized.end);
  const ref = isRange
    ? formatRange(normalized.start, normalized.end, openEnded)
    : formatAddress(normalized.start);

  return ctx.sheetName && ctx.sheetName !== ctx.defaultSheet ? `${ctx.sheetName}!${ref}` : ref;
}

/**
 * Shift explicit column/row mapping keys with their range. Horizontal tables key
 * mappings by column letter, vertical tables by row number, so each key type
 * moves on its own axis; keys that would leave the sheet are dropped.
 */
export function shiftMappingKeys(
  columns: Record<string, string>,
  dc: number,
  dr: number,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(columns)) {
    if (/^[A-Z]+$/.test(key)) {
      const shifted = shiftColumnKey(key, dc);
      if (shifted) next[shifted] = value;
      continue;
    }
    if (/^\d+$/.test(key)) {
      const shifted = shiftRowKey(key, dr);
      if (shifted) next[shifted] = value;
      continue;
    }
    next[key] = value;
  }
  return next;
}

/** Drop mapping keys that fall outside the range (used when a range shrinks). */
export function filterMappingKeysToRange(
  columns: Record<string, string>,
  selection: Selection,
): Record<string, string> {
  const normalized = normalizeRange(selection.start, selection.end);
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(columns)) {
    if (/^[A-Z]+$/.test(key)) {
      const col = letterToColIndex(key);
      if (col >= normalized.start.col && col <= normalized.end.col) {
        next[key] = value;
      }
      continue;
    }
    const row = /^\d+$/.test(key) ? parseInt(key, 10) - 1 : null;
    if (row !== null && row >= normalized.start.row && row <= normalized.end.row) {
      next[key] = value;
    }
  }
  return next;
}

/**
 * Rewrite a field for a new selection. This is the single place that decides the
 * cell/range reference, the field type and which range-dependent metadata
 * survives, so gestures and the field dialog can never disagree.
 */
export function applySelectionToField(
  field: StencilField,
  selection: Selection,
  ctx: FieldRefContext,
): StencilField {
  const normalized = normalizeRange(selection.start, selection.end);
  const isRange = isRangeSelection(normalized.start, normalized.end);
  const type = typeForShape(field.type, isRange);
  const source = ctx.sourceRange ? normalizeRange(ctx.sourceRange.start, ctx.sourceRange.end) : null;

  let columns = field.columns && Object.keys(field.columns).length > 0 ? field.columns : undefined;
  if (columns && source) {
    if (sameRangeShape(source, normalized)) {
      columns = shiftMappingKeys(columns, normalized.start.col - source.start.col, normalized.start.row - source.start.row);
    } else {
      // Resized: the dialog re-derives the mapping from the new range.
      columns = undefined;
    }
  }
  if (type !== 'table') {
    columns = undefined;
  }

  const ref = selectionToRef(normalized, ctx, isRange ? Boolean(field.openEnded) : false);
  const openEnded = isRange ? field.openEnded : undefined;

  return {
    ...field,
    type,
    cell: isRange ? undefined : ref,
    range: isRange ? ref : undefined,
    openEnded,
    blankRows: openEnded ? field.blankRows : undefined,
    tableOrientation: type === 'table' ? field.tableOrientation : undefined,
    columns,
  };
}
