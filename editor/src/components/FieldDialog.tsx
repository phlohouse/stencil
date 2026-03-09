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

function suggestFieldName(
  selection: Selection,
  sheetData: SheetData | null,
  isRange: boolean,
): string {
  if (!sheetData) return '';

  if (isRange) {
    // For a range starting at row N, peek at row N-1 for a header
    const headerRow = selection.start.row - 1;
    if (headerRow >= 0) {
      const headerValue = sheetData.data[headerRow]?.[selection.start.col];
      if (headerValue != null && typeof headerValue === 'string' && headerValue.trim()) {
        return slugify(headerValue);
      }
    }
  } else {
    // For a single cell, peek at the cell to the left or above
    const above = selection.start.row - 1;
    if (above >= 0) {
      const val = sheetData.data[above]?.[selection.start.col];
      if (val != null && typeof val === 'string' && val.trim()) {
        return slugify(val);
      }
    }
    const left = selection.start.col - 1;
    if (left >= 0) {
      const val = sheetData.data[selection.start.row]?.[left];
      if (val != null && typeof val === 'string' && val.trim()) {
        return slugify(val);
      }
    }
  }

  return '';
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
  onSave,
  onCancel,
}: FieldDialogProps) {
  const normalized = normalizeRange(selection.start, selection.end);
  const isRange = isRangeSelection(normalized.start, normalized.end);
  const horizontalColumnGroups = sheetData
    ? getHorizontalColumnGroups(normalized, sheetData)
    : [];

  const [name, setName] = useState(() => initialField?.name ?? suggestFieldName(selection, sheetData, isRange));
  const [type, setType] = useState(() => initialField?.type ?? (isRange ? 'list[str]' : 'str'));
  const [tableOrientation, setTableOrientation] = useState<'horizontal' | 'vertical'>(
    () => initialField?.tableOrientation ?? 'horizontal',
  );
  const [openEnded, setOpenEnded] = useState(() => initialField?.openEnded ?? false);
  const [computed, setComputed] = useState(() => initialField?.computed ?? '');
  const [isComputed, setIsComputed] = useState(() => Boolean(initialField?.computed));
  const [columns, setColumns] = useState<Record<string, string>>(() => {
    if ((initialField?.type === 'table' || initialField?.columns) && isRange) {
      const guessed = (initialField?.tableOrientation ?? tableOrientation) === 'vertical'
        ? guessTableRows(normalized, sheetData)
        : guessTableColumns(normalized, sheetData);
      return {
        ...guessed,
        ...(initialField?.columns ?? {}),
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
          ...prev,
        }));
      } else {
        setColumns((prev) => ({
          ...guessTableRows(normalized, sheetData),
          ...prev,
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
      ...prev,
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <form
        onSubmit={handleSubmit}
        className="bg-gray-800 rounded-xl border border-gray-700 p-6 w-full max-w-md shadow-2xl"
      >
        <h3 className="text-lg font-semibold text-white mb-1">
          {title ?? (initialField ? 'Edit Field' : 'Define Field')}
        </h3>
        <p className="text-sm text-gray-400 font-mono mb-5">
          {isRange ? 'Range' : 'Cell'}: {sheetQualifiedRef}
        </p>

        {/* Field name */}
        <label className="block mb-4">
          <span className="text-sm text-gray-300 mb-1 block">Field Name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="field_name"
            className="w-full px-3 py-2 bg-gray-900 border border-gray-600 rounded-lg text-white font-mono text-sm placeholder:text-gray-500 focus:outline-none focus:border-blue-500"
            autoFocus
          />
        </label>

        {/* Computed toggle */}
        <label className="flex items-center gap-2 mb-4 cursor-pointer">
          <input
            type="checkbox"
            checked={isComputed}
            onChange={(e) => setIsComputed(e.target.checked)}
            className="rounded border-gray-600"
          />
          <span className="text-sm text-gray-300">Computed field</span>
        </label>

        {isComputed ? (
          <label className="block mb-4">
            <span className="text-sm text-gray-300 mb-1 block">Expression</span>
            <input
              type="text"
              value={computed}
              onChange={(e) => setComputed(e.target.value)}
              placeholder='{first_name} {last_name}'
              className="w-full px-3 py-2 bg-gray-900 border border-gray-600 rounded-lg text-white font-mono text-sm placeholder:text-gray-500 focus:outline-none focus:border-blue-500"
            />
          </label>
        ) : (
          <>
            {/* Type */}
            <label className="block mb-4">
              <span className="text-sm text-gray-300 mb-1 block">Type</span>
              <select
                value={type}
                onChange={(e) => handleTypeChange(e.target.value)}
                className="w-full px-3 py-2 bg-gray-900 border border-gray-600 rounded-lg text-white text-sm focus:outline-none focus:border-blue-500"
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
                  className="rounded border-gray-600"
                />
                <span className="text-sm text-gray-300">
                  Open-ended range
                </span>
                <span className="text-xs text-gray-500 font-mono">
                  ({formatRange(normalized.start, normalized.end, true)})
                </span>
              </label>
            )}

            {/* Table columns */}
            {type === 'table' && isRange && (
              <label className="block mb-4">
                <span className="text-sm text-gray-300 mb-1 block">Orientation</span>
                <select
                  value={tableOrientation}
                  onChange={(e) => setTableOrientation(e.target.value as 'horizontal' | 'vertical')}
                  className="w-full px-3 py-2 bg-gray-900 border border-gray-600 rounded-lg text-white text-sm focus:outline-none focus:border-blue-500"
                >
                  <option value="horizontal">Horizontal (headers on top)</option>
                  <option value="vertical">Vertical (headers on left)</option>
                </select>
              </label>
            )}

            {/* Table columns */}
            {type === 'table' && isRange && tableOrientation === 'horizontal' && (
              <div className="mb-4">
                <span className="text-sm text-gray-300 mb-2 block">Column Mapping</span>
                <div className="space-y-2">
                  {horizontalColumnGroups.map((group) => (
                    <div key={`${group.startCol}-${group.endCol}`} className="flex items-center gap-2">
                      <span className="text-sm text-gray-400 font-mono w-12">
                        {formatColumnGroupLabel(group)}
                      </span>
                      <input
                        type="text"
                        value={getColumnGroupValue(columns, group)}
                        onChange={(e) =>
                          setColumns((prev) => setColumnGroupValue(prev, group, e.target.value))
                        }
                        placeholder="column_name"
                        className="flex-1 px-2 py-1 bg-gray-900 border border-gray-600 rounded text-white font-mono text-sm placeholder:text-gray-500 focus:outline-none focus:border-blue-500"
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {type === 'table' && isRange && tableOrientation === 'vertical' && (
              <div className="mb-4">
                <span className="text-sm text-gray-300 mb-2 block">Row Mapping</span>
                <div className="space-y-2">
                  {Array.from(
                    { length: normalized.end.row - normalized.start.row + 1 },
                    (_, i) => {
                      const rowNumber = normalized.start.row + i + 1;
                      const rowKey = String(rowNumber);
                      return (
                        <div key={rowKey} className="flex items-center gap-2">
                          <span className="text-sm text-gray-400 font-mono w-10">
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
                            className="flex-1 px-2 py-1 bg-gray-900 border border-gray-600 rounded text-white font-mono text-sm placeholder:text-gray-500 focus:outline-none focus:border-blue-500"
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
            className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!name.trim()}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors"
          >
            {initialField ? 'Update Field' : 'Add Field'}
          </button>
        </div>
      </form>
    </div>
  );
}
