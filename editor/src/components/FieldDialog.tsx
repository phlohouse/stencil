import { useState, useCallback, useEffect, type FormEvent } from 'react';
import type { Selection, StencilField } from '../lib/types';
import type { SheetData } from '../lib/excel';
import { FIELD_TYPES } from '../lib/types';
import { formatRange, normalizeRange, isRangeSelection, formatAddress, colIndexToLetter } from '../lib/addressing';
import { slugify } from '../lib/field-naming';

interface ColumnGroup {
  startCol: number;
  endCol: number;
}

function isColumnLetterKey(key: string): boolean {
  return /^[A-Z]+$/.test(key);
}

function isRowNumberKey(key: string): boolean {
  return /^\d+$/.test(key);
}

function filterMappingsForOrientation(
  columns: Record<string, string>,
  orientation: 'horizontal' | 'vertical',
): Record<string, string> {
  const entries = Object.entries(columns).filter(([key]) =>
    orientation === 'horizontal' ? isColumnLetterKey(key) : isRowNumberKey(key),
  );
  return Object.fromEntries(entries);
}

function fuzzyFieldMatch(slug: string, names: string[]): string | null {
  if (names.length === 0) return null;

  const slugTokens = slug.split('_').filter(Boolean);

  let bestName: string | null = null;
  let bestScore = 0;

  for (const name of names) {
    // Exact match
    if (name === slug) return name;

    const nameTokens = name.split('_').filter(Boolean);

    // Count shared tokens (order-independent)
    const shared = slugTokens.filter((t) =>
      nameTokens.some((nt) => nt === t || nt.startsWith(t) || t.startsWith(nt)),
    ).length;

    const maxTokens = Math.max(slugTokens.length, nameTokens.length);
    if (maxTokens === 0) continue;

    const score = shared / maxTokens;

    // Require at least half the tokens to overlap
    if (score > bestScore && score >= 0.5) {
      bestScore = score;
      bestName = name;
    }
  }

  return bestName;
}

function suggestFieldName(
  selection: Selection,
  sheetData: SheetData | null,
  isRange: boolean,
  otherVersionFieldNames: string[] = [],
): string {
  if (!sheetData) return '';

  const candidates: string[] = [];

  if (isRange) {
    const headerRow = selection.start.row - 1;
    if (headerRow >= 0) {
      const headerValue = sheetData.data[headerRow]?.[selection.start.col];
      if (headerValue != null && typeof headerValue === 'string' && headerValue.trim()) {
        candidates.push(headerValue);
      }
    }
  } else {
    const above = selection.start.row - 1;
    if (above >= 0) {
      const val = sheetData.data[above]?.[selection.start.col];
      if (val != null && typeof val === 'string' && val.trim()) {
        candidates.push(val);
      }
    }
    const left = selection.start.col - 1;
    if (left >= 0) {
      const val = sheetData.data[selection.start.row]?.[left];
      if (val != null && typeof val === 'string' && val.trim()) {
        candidates.push(val);
      }
    }
  }

  if (candidates.length === 0) return '';

  const slug = slugify(candidates[0]);
  if (!slug) return '';

  // If an existing field name from another version fuzzy-matches, prefer it
  return fuzzyFieldMatch(slug, otherVersionFieldNames) ?? slug;
}

function guessTableColumns(
  normalized: { start: { col: number; row: number }; end: { col: number; row: number } },
  sheetData: SheetData | null,
): Record<string, string> {
  if (!sheetData) return {};
  const columns: Record<string, string> = {};
  const headerRow = findBestTableHeaderRow(normalized, sheetData);
  const groups = getHorizontalColumnGroups(normalized, sheetData, headerRow);

  for (const group of groups) {
    const val = sheetData.data[headerRow]?.[group.startCol];
    const name = val != null && String(val).trim() ? slugify(String(val)) : '';
    for (let c = group.startCol; c <= group.endCol; c++) {
      if (name) {
        columns[colIndexToLetter(c)] = name;
      }
    }
  }

  return columns;
}

function getHorizontalColumnGroups(
  normalized: { start: { col: number; row: number }; end: { col: number; row: number } },
  sheetData: SheetData,
  headerRow = findBestTableHeaderRow(normalized, sheetData),
): ColumnGroup[] {
  const groups: ColumnGroup[] = [];

  for (let c = normalized.start.col; c <= normalized.end.col; c++) {
    const merge = sheetData.cells[headerRow]?.[c]?.merge;
    if (merge && merge.left >= normalized.start.col && merge.right <= normalized.end.col) {
      if (c !== merge.left) continue;
      groups.push({ startCol: merge.left, endCol: merge.right });
      c = merge.right;
      continue;
    }
    groups.push({ startCol: c, endCol: c });
  }

  return groups;
}

function formatColumnGroupLabel(group: ColumnGroup): string {
  const start = colIndexToLetter(group.startCol);
  const end = colIndexToLetter(group.endCol);
  return group.startCol === group.endCol ? `${start}:` : `${start}-${end}:`;
}

function getColumnGroupValue(columns: Record<string, string>, group: ColumnGroup): string {
  return columns[colIndexToLetter(group.startCol)] ?? '';
}

function setColumnGroupValue(
  prev: Record<string, string>,
  group: ColumnGroup,
  value: string,
): Record<string, string> {
  const next = { ...prev };
  for (let c = group.startCol; c <= group.endCol; c++) {
    next[colIndexToLetter(c)] = value;
  }
  return next;
}

function findBestTableHeaderRow(
  normalized: { start: { col: number; row: number }; end: { col: number; row: number } },
  sheetData: SheetData,
): number {
  const maxRow = Math.min(normalized.end.row, normalized.start.row + 2);
  let bestRow = normalized.start.row;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (let row = normalized.start.row; row <= maxRow; row++) {
    const values = [];
    for (let col = normalized.start.col; col <= normalized.end.col; col++) {
      const value = sheetData.data[row]?.[col];
      values.push(value == null ? '' : String(value).trim());
    }

    const nonEmpty = values.filter(Boolean);
    if (nonEmpty.length === 0) continue;

    const uniqueCount = new Set(nonEmpty.map((value) => value.toLowerCase())).size;
    const repeatedPenalty = uniqueCount <= Math.ceil(nonEmpty.length / 2) ? 2 : 0;
    const headerLikeCount = nonEmpty.filter((value) => /[a-z]/i.test(value) && value.length <= 40).length;
    const numericPenalty = nonEmpty.filter((value) => /^-?\d+(\.\d+)?$/.test(value)).length;
    const mergeBonus = getHorizontalColumnGroups(normalized, sheetData, row)
      .some((group) => group.endCol > group.startCol) ? 1 : 0;
    const score = headerLikeCount - repeatedPenalty - numericPenalty + mergeBonus;

    if (score > bestScore) {
      bestScore = score;
      bestRow = row;
    }
  }

  return bestRow;
}

function guessTableRows(
  normalized: { start: { col: number; row: number }; end: { col: number; row: number } },
  sheetData: SheetData | null,
): Record<string, string> {
  if (!sheetData) return {};
  const rows: Record<string, string> = {};
  const headerCol = normalized.start.col;

  for (let r = normalized.start.row; r <= normalized.end.row; r++) {
    const val = sheetData.data[r]?.[headerCol];
    const rowKey = String(r + 1);
    if (val != null && String(val).trim()) {
      rows[rowKey] = slugify(String(val));
    }
  }

  return rows;
}

interface FieldDialogProps {
  selection: Selection;
  activeSheet: string;
  defaultSheet: string;
  sheetData: SheetData | null;
  initialField?: StencilField | null;
  title?: string;
  otherVersionFieldNames?: string[];
  currentVersionFieldNames?: string[];
  onSave: (field: StencilField) => void;
  onCancel: () => void;
}

export function FieldDialog({
  selection,
  activeSheet,
  defaultSheet,
  sheetData,
  initialField,
  title,
  otherVersionFieldNames = [],
  currentVersionFieldNames = [],
  onSave,
  onCancel,
}: FieldDialogProps) {
  const normalized = normalizeRange(selection.start, selection.end);
  const isRange = isRangeSelection(normalized.start, normalized.end);
  const horizontalColumnGroups = sheetData
    ? getHorizontalColumnGroups(normalized, sheetData)
    : [];

  const [name, setName] = useState(() => initialField?.name ?? suggestFieldName(selection, sheetData, isRange, otherVersionFieldNames));
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [type, setType] = useState(() => initialField?.type ?? (isRange ? 'list[str]' : 'str'));
  const [tableOrientation, setTableOrientation] = useState<'horizontal' | 'vertical'>(
    () => initialField?.tableOrientation ?? 'horizontal',
  );
  const [openEnded, setOpenEnded] = useState(() => initialField?.openEnded ?? false);
  const [computed, setComputed] = useState(() => initialField?.computed ?? '');
  const [isComputed, setIsComputed] = useState(() => Boolean(initialField?.computed));
  const [columns, setColumns] = useState<Record<string, string>>(() => {
    if ((initialField?.type === 'table' || initialField?.columns) && isRange) {
      const orientation = initialField?.tableOrientation ?? tableOrientation;
      const guessed = orientation === 'vertical'
        ? guessTableRows(normalized, sheetData)
        : guessTableColumns(normalized, sheetData);
      const existing = filterMappingsForOrientation(initialField?.columns ?? {}, orientation);
      return {
        ...guessed,
        ...existing,
      };
    }
    return {};
  });

  const ref = isRange
    ? formatRange(normalized.start, normalized.end, openEnded)
    : formatAddress(normalized.start);

  const sheetQualifiedRef =
    activeSheet !== defaultSheet ? `${activeSheet}!${ref}` : ref;

  const handleTypeChange = useCallback((newType: string) => {
    setType(newType);
    if (newType === 'table') {
      setOpenEnded(true);
      if (tableOrientation === 'horizontal') {
        setColumns((prev) => ({
          ...guessTableColumns(normalized, sheetData),
          ...filterMappingsForOrientation(prev, 'horizontal'),
        }));
      } else {
        setColumns((prev) => ({
          ...guessTableRows(normalized, sheetData),
          ...filterMappingsForOrientation(prev, 'vertical'),
        }));
      }
    }
  }, [normalized, sheetData, tableOrientation]);

  useEffect(() => {
    if (type !== 'table' || !isRange) return;
    const guessed = tableOrientation === 'vertical'
      ? guessTableRows(normalized, sheetData)
      : guessTableColumns(normalized, sheetData);
    setColumns((prev) => ({
      ...guessed,
      ...filterMappingsForOrientation(prev, tableOrientation),
    }));
  }, [type, isRange, tableOrientation, normalized, sheetData]);

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      if (!name.trim()) return;

      const field: StencilField = { name: name.trim() };

      if (isComputed) {
        field.computed = computed;
      } else if (isRange) {
        field.range = sheetQualifiedRef;
        field.type = type;
        field.openEnded = openEnded;
        if (type === 'table') {
          field.tableOrientation = tableOrientation;
        }
        if (type === 'table' && Object.keys(columns).length > 0) {
          field.columns = columns;
        }
      } else {
        field.cell = sheetQualifiedRef;
        if (type !== 'str') field.type = type;
      }

      onSave(field);
    },
    [name, isComputed, computed, isRange, sheetQualifiedRef, type, openEnded, tableOrientation, columns, onSave],
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <form
        onSubmit={handleSubmit}
        className="bg-elevated rounded-xl border border-border p-6 w-full max-w-md shadow-2xl"
      >
        <h3 className="text-lg font-semibold text-text mb-1">
          {title ?? (initialField ? 'Edit Field' : 'Define Field')}
        </h3>
        <p className="text-sm text-text-secondary font-mono mb-5">
          {isRange ? 'Range' : 'Cell'}: {sheetQualifiedRef}
        </p>

        {/* Field name */}
        <div className="block mb-4">
          <span className="text-sm text-text-secondary mb-1 block">Field Name</span>
          <div className="relative">
            <input
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setShowSuggestions(true);
              }}
              onFocus={() => setShowSuggestions(true)}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
              placeholder="field_name"
              className="w-full px-3 py-2 bg-surface border border-border-strong rounded-lg text-text font-mono text-sm placeholder:text-text-muted focus:outline-none focus:border-accent"
              autoFocus
            />
            {showSuggestions && otherVersionFieldNames.length > 0 && (() => {
              const currentSet = new Set(currentVersionFieldNames);
              const filtered = otherVersionFieldNames.filter(
                (n) => n !== name && (!name || n.toLowerCase().includes(name.toLowerCase())),
              );
              if (filtered.length === 0) return null;
              const missing = filtered.filter((n) => !currentSet.has(n));
              const existing = filtered.filter((n) => currentSet.has(n));
              const renderItem = (n: string) => (
                <button
                  key={n}
                  type="button"
                  className="w-full text-left px-3 py-1.5 text-sm font-mono text-text hover:bg-surface transition-colors"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setName(n);
                    setShowSuggestions(false);
                  }}
                >
                  {n}
                </button>
              );
              return (
                <div className="absolute z-10 top-full left-0 right-0 mt-1 max-h-40 overflow-y-auto rounded-lg border border-border bg-elevated shadow-lg">
                  {missing.map(renderItem)}
                  {missing.length > 0 && existing.length > 0 && (
                    <div className="border-t border-border mx-2 my-1" />
                  )}
                  {existing.map(renderItem)}
                </div>
              );
            })()}
          </div>
        </div>

        {/* Computed toggle */}
        <label className="flex items-center gap-2 mb-4 cursor-pointer">
          <input
            type="checkbox"
            checked={isComputed}
            onChange={(e) => setIsComputed(e.target.checked)}
            className="rounded border-border-strong"
          />
          <span className="text-sm text-text-secondary">Computed field</span>
        </label>

        {isComputed ? (
          <label className="block mb-4">
            <span className="text-sm text-text-secondary mb-1 block">Expression</span>
            <input
              type="text"
              value={computed}
              onChange={(e) => setComputed(e.target.value)}
              placeholder='{first_name} {last_name}'
              className="w-full px-3 py-2 bg-surface border border-border-strong rounded-lg text-text font-mono text-sm placeholder:text-text-muted focus:outline-none focus:border-accent"
            />
          </label>
        ) : (
          <>
            {/* Type */}
            <label className="block mb-4">
              <span className="text-sm text-text-secondary mb-1 block">Type</span>
              <select
                value={type}
                onChange={(e) => handleTypeChange(e.target.value)}
                className="w-full px-3 py-2 bg-surface border border-border-strong rounded-lg text-text text-sm focus:outline-none focus:border-accent"
              >
                {FIELD_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>

            {/* Open-ended range */}
            {isRange && (
              <label className="flex items-center gap-2 mb-4 cursor-pointer">
                <input
                  type="checkbox"
                  checked={openEnded}
                  onChange={(e) => setOpenEnded(e.target.checked)}
                  className="rounded border-border-strong"
                />
                <span className="text-sm text-text-secondary">
                  Open-ended range
                </span>
                <span className="text-xs text-text-muted font-mono">
                  ({formatRange(normalized.start, normalized.end, true)})
                </span>
              </label>
            )}

            {/* Table columns */}
            {type === 'table' && isRange && (
              <label className="block mb-4">
                <span className="text-sm text-text-secondary mb-1 block">Orientation</span>
                <select
                  value={tableOrientation}
                  onChange={(e) => setTableOrientation(e.target.value as 'horizontal' | 'vertical')}
                  className="w-full px-3 py-2 bg-surface border border-border-strong rounded-lg text-text text-sm focus:outline-none focus:border-accent"
                >
                  <option value="horizontal">Horizontal (headers on top)</option>
                  <option value="vertical">Vertical (headers on left)</option>
                </select>
              </label>
            )}

            {/* Table columns */}
            {type === 'table' && isRange && tableOrientation === 'horizontal' && (
              <div className="mb-4">
                <span className="text-sm text-text-secondary mb-2 block">Column Mapping</span>
                <div className="space-y-2">
                  {horizontalColumnGroups.map((group) => (
                    <div key={`${group.startCol}-${group.endCol}`} className="flex items-center gap-2">
                      <span className="text-sm text-text-secondary font-mono w-12">
                        {formatColumnGroupLabel(group)}
                      </span>
                      <input
                        type="text"
                        value={getColumnGroupValue(columns, group)}
                        onChange={(e) =>
                          setColumns((prev) => setColumnGroupValue(prev, group, e.target.value))
                        }
                        placeholder="column_name"
                        className="flex-1 px-2 py-1 bg-surface border border-border-strong rounded text-text font-mono text-sm placeholder:text-text-muted focus:outline-none focus:border-accent"
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {type === 'table' && isRange && tableOrientation === 'vertical' && (
              <div className="mb-4">
                <span className="text-sm text-text-secondary mb-2 block">Row Mapping</span>
                <div className="space-y-2">
                  {Array.from(
                    { length: normalized.end.row - normalized.start.row + 1 },
                    (_, i) => {
                      const rowNumber = normalized.start.row + i + 1;
                      const rowKey = String(rowNumber);
                      return (
                        <div key={rowKey} className="flex items-center gap-2">
                          <span className="text-sm text-text-secondary font-mono w-10">
                            {rowNumber}:
                          </span>
                          <input
                            type="text"
                            value={columns[rowKey] ?? ''}
                            onChange={(e) =>
                              setColumns((prev) => ({
                                ...prev,
                                [rowKey]: e.target.value,
                              }))
                            }
                            placeholder="field_name"
                            className="flex-1 px-2 py-1 bg-surface border border-border-strong rounded text-text font-mono text-sm placeholder:text-text-muted focus:outline-none focus:border-accent"
                          />
                        </div>
                      );
                    },
                  )}
                </div>
              </div>
            )}
          </>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-3 mt-6">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm text-text-secondary hover:text-text transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!name.trim()}
            className="px-4 py-2 bg-accent hover:bg-accent-hover disabled:bg-border-strong disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors"
          >
            {initialField ? 'Update Field' : 'Add Field'}
          </button>
        </div>
      </form>
    </div>
  );
}
