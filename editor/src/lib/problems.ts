import { letterToColIndex, parseAddress } from './addressing';
import type { StencilField, StencilVersion } from './types';

export type SchemaProblemKind = 'overlap' | 'table-columns' | 'version-key' | 'discriminator';

export interface SchemaProblem {
  kind: SchemaProblemKind;
  /** Fields the problem is about, used to jump to the first one. */
  fieldNames: string[];
  message: string;
}

interface ParsedFieldRef {
  sheetName: string;
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}

const UNBOUNDED = Number.MAX_SAFE_INTEGER;

function splitSheetRef(ref: string, defaultSheet: string): { sheetName: string; value: string } {
  const bangIndex = ref.indexOf('!');
  if (bangIndex < 0) return { sheetName: defaultSheet, value: ref };
  return {
    sheetName: ref.slice(0, bangIndex).trim() || defaultSheet,
    value: ref.slice(bangIndex + 1).trim(),
  };
}

/** Parse a field's `cell`/`range` into a rectangle; open-ended ranges stay unbounded. */
export function parseFieldRef(ref: string, defaultSheet: string): ParsedFieldRef | null {
  const { sheetName, value } = splitSheetRef(ref, defaultSheet);
  const [startRef, endRefMaybe] = value.toUpperCase().split(':');
  if (!startRef) return null;

  try {
    const start = parseAddress(startRef);
    if (!endRefMaybe) {
      return {
        sheetName,
        startRow: start.row,
        endRow: start.row,
        startCol: start.col,
        endCol: start.col,
      };
    }

    // An open-ended range keeps the rows open (`A5:D`).
    if (/^[A-Z]+$/.test(endRefMaybe)) {
      const endCol = letterToColIndex(endRefMaybe);
      return {
        sheetName,
        startRow: start.row,
        endRow: UNBOUNDED,
        startCol: Math.min(start.col, endCol),
        endCol: Math.max(start.col, endCol),
      };
    }

    const end = parseAddress(endRefMaybe);
    return {
      sheetName,
      startRow: Math.min(start.row, end.row),
      endRow: Math.max(start.row, end.row),
      startCol: Math.min(start.col, end.col),
      endCol: Math.max(start.col, end.col),
    };
  } catch {
    return null;
  }
}

function refsOverlap(a: ParsedFieldRef, b: ParsedFieldRef): boolean {
  return a.sheetName === b.sheetName
    && a.startRow <= b.endRow
    && b.startRow <= a.endRow
    && a.startCol <= b.endCol
    && b.startCol <= a.endCol;
}

/** Problems worth showing before extraction, for the active version. */
export function findSchemaProblems(
  fields: StencilField[],
  versions: StencilVersion[],
  activeVersionValue: string | undefined,
  defaultSheet: string,
): SchemaProblem[] {
  const problems: SchemaProblem[] = [];
  const placed = fields
    .map((field) => ({ field, ref: field.cell ?? field.range }))
    .filter((entry): entry is { field: StencilField; ref: string } => Boolean(entry.ref))
    .map((entry) => ({ field: entry.field, parsed: parseFieldRef(entry.ref, defaultSheet) }))
    .filter((entry): entry is { field: StencilField; parsed: ParsedFieldRef } => entry.parsed !== null);

  for (let index = 0; index < placed.length; index += 1) {
    for (let other = index + 1; other < placed.length; other += 1) {
      const a = placed[index];
      const b = placed[other];
      if (!refsOverlap(a.parsed, b.parsed)) continue;

      problems.push({
        kind: 'overlap',
        fieldNames: [a.field.name, b.field.name],
        message: `"${a.field.name}" and "${b.field.name}" map overlapping cells`,
      });
    }
  }

  for (const entry of placed) {
    const { field, parsed } = entry;
    if (field.type !== 'table' || !field.columns) continue;

    const outside: string[] = [];
    for (const key of Object.keys(field.columns)) {
      if (field.tableOrientation === 'vertical') {
        const row = Number(key);
        if (!Number.isFinite(row) || row < parsed.startRow + 1 || row > parsed.endRow + 1) {
          outside.push(key);
        }
        continue;
      }
      const col = letterToColIndex(key);
      if (col < parsed.startCol || col > parsed.endCol) outside.push(key);
    }

    if (outside.length > 0) {
      problems.push({
        kind: 'table-columns',
        fieldNames: [field.name],
        message: `"${field.name}" maps ${outside.join(', ')} outside its range`,
      });
    }
  }

  const seenValues = new Map<string, number>();
  for (const version of versions) {
    const value = version.discriminatorValue.trim();
    if (!value) {
      problems.push({
        kind: 'version-key',
        fieldNames: [],
        message: 'a version has no discriminator value, so no file can match it',
      });
      continue;
    }
    seenValues.set(value, (seenValues.get(value) ?? 0) + 1);
  }
  for (const [value, count] of seenValues) {
    if (count > 1) {
      problems.push({
        kind: 'version-key',
        fieldNames: [],
        message: `${count} versions use the discriminator value "${value}"`,
      });
    }
  }

  if (versions.length > 1 && !activeVersionValue?.trim()) {
    problems.push({
      kind: 'discriminator',
      fieldNames: [],
      message: 'several versions are defined but the active version has no discriminator value',
    });
  }

  return problems;
}
