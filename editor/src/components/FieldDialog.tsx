import { useState, useCallback, useEffect, type FormEvent } from 'react';
import type { Selection, StencilField } from '../lib/types';
import type { SheetData } from '../lib/excel';
import { FIELD_TYPES } from '../lib/types';
import { formatRange, normalizeRange, isRangeSelection, formatAddress, colIndexToLetter, letterToColIndex, parseAddress } from '../lib/addressing';
import { slugify } from '../lib/field-naming';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Input } from './ui/input';
import { Label } from './ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from './ui/sheet';

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

function mappingsEqual(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;

  return leftKeys.every((key) => left[key] === right[key]);
}

function summarizeMappingValues(columns: Record<string, string>, limit = 4): string[] {
  return Object.values(columns)
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, limit);
}

function formatPreviewValue(value: unknown): string {
  if (value == null || value === '') return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return String(value);
}

interface PreviewCell {
  value: string;
  colSpan?: number;
  rowSpan?: number;
}

function buildRangePreview(
  sheetData: SheetData | null,
  normalized: { start: { col: number; row: number }; end: { col: number; row: number } },
  isRange: boolean,
): PreviewCell[][] {
  if (!sheetData) return [];

  const maxRows = isRange ? 6 : 1;
  const maxCols = isRange ? 6 : 1;
  const rows: PreviewCell[][] = [];

  for (
    let row = normalized.start.row;
    row <= normalized.end.row && row < sheetData.rows && rows.length < maxRows;
    row += 1
  ) {
    const currentRow: PreviewCell[] = [];
    let visibleCols = 0;
    for (let col = normalized.start.col; col <= normalized.end.col && col < sheetData.cols; col += 1) {
      const cellInfo = sheetData.cells[row]?.[col];
      const merge = cellInfo?.merge;
      if (merge && !merge.isAnchor) {
        continue;
      }

      const colSpan = merge
        ? Math.min(merge.right, normalized.end.col, normalized.start.col + maxCols - 1) - col + 1
        : 1;
      const rowSpan = merge
        ? Math.min(merge.bottom, normalized.end.row, normalized.start.row + maxRows - 1) - row + 1
        : 1;

      currentRow.push({
        value: formatPreviewValue(sheetData.data[row]?.[col]),
        colSpan,
        rowSpan,
      });

      visibleCols += colSpan;
      if (visibleCols >= maxCols) {
        break;
      }
    }
    rows.push(currentRow);
  }

  return rows;
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

interface ParsedReference {
  sheetName: string;
  start: { col: number; row: number };
  end: { col: number; row: number };
  isRange: boolean;
  openEnded: boolean;
}

function parseReferenceInput(
  input: string,
  activeSheet: string,
  defaultSheet: string,
): ParsedReference | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const bangIndex = trimmed.indexOf('!');
  const sheetName = bangIndex >= 0 ? trimmed.slice(0, bangIndex).trim() : activeSheet;
  const refPart = (bangIndex >= 0 ? trimmed.slice(bangIndex + 1) : trimmed).trim().toUpperCase();
  if (!refPart) return null;

  const [startRef, endRef] = refPart.split(':');
  if (!startRef) return null;

  try {
    const start = parseAddress(startRef);
    if (!endRef) {
      return {
        sheetName: sheetName || defaultSheet,
        start,
        end: start,
        isRange: false,
        openEnded: false,
      };
    }

    const openEndedMatch = endRef.match(/^([A-Z]+)$/);
    if (openEndedMatch?.[1]) {
      return {
        sheetName: sheetName || defaultSheet,
        start,
        end: { col: letterToColIndex(openEndedMatch[1]), row: start.row },
        isRange: true,
        openEnded: true,
      };
    }

    const end = parseAddress(endRef);
    return {
      sheetName: sheetName || defaultSheet,
      start,
      end,
      isRange: true,
      openEnded: false,
    };
  } catch {
    return null;
  }
}

function referencesPointToSameSelection(
  ref: string | undefined,
  selection: Selection,
  activeSheet: string,
  defaultSheet: string,
): boolean {
  if (!ref) return false;
  const parsed = parseReferenceInput(ref, activeSheet, defaultSheet);
  if (!parsed) return false;
  const normalizedParsed = normalizeRange(parsed.start, parsed.end);
  const normalizedSelection = normalizeRange(selection.start, selection.end);
  return parsed.sheetName === activeSheet
    && normalizedParsed.start.col === normalizedSelection.start.col
    && normalizedParsed.start.row === normalizedSelection.start.row
    && normalizedParsed.end.col === normalizedSelection.end.col
    && normalizedParsed.end.row === normalizedSelection.end.row;
}

interface FieldDialogProps {
  open: boolean;
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
  open,
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
  const selectionIsRange = isRangeSelection(normalized.start, normalized.end);
  const selectionReference = `${activeSheet !== defaultSheet ? `${activeSheet}!` : ''}${selectionIsRange ? formatRange(normalized.start, normalized.end) : formatAddress(normalized.start)}`;
  const initialFieldReference = initialField?.cell ?? initialField?.range;
  const initialReference = initialFieldReference && referencesPointToSameSelection(initialFieldReference, selection, activeSheet, defaultSheet)
    ? initialFieldReference
    : selectionReference;
  const [referenceInput, setReferenceInput] = useState(initialReference);
  const parsedReference = parseReferenceInput(referenceInput, activeSheet, defaultSheet);
  const effectiveNormalized = parsedReference
    ? normalizeRange(parsedReference.start, parsedReference.end)
    : normalized;
  const isRange = parsedReference?.isRange ?? selectionIsRange;
  const horizontalColumnGroups = sheetData
    ? getHorizontalColumnGroups(effectiveNormalized, sheetData)
    : [];
  const expectedRefKind = initialField?.range || (!initialField && selectionIsRange) ? 'range' : 'cell';

  const [name, setName] = useState(() => initialField?.name ?? suggestFieldName(selection, sheetData, selectionIsRange, otherVersionFieldNames));
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [type, setType] = useState(() => initialField?.type ?? (isRange ? 'list[str]' : 'str'));
  const [tableOrientation, setTableOrientation] = useState<'horizontal' | 'vertical'>(
    () => initialField?.tableOrientation ?? 'horizontal',
  );
  const [openEnded, setOpenEnded] = useState(() => initialField?.openEnded ?? parsedReference?.openEnded ?? false);
  const [computed, setComputed] = useState(() => initialField?.computed ?? '');
  const [isComputed, setIsComputed] = useState(() => Boolean(initialField?.computed));
  const [referenceError, setReferenceError] = useState<string | null>(null);
  const [columns, setColumns] = useState<Record<string, string>>(() => {
    if ((initialField?.type === 'table' || initialField?.columns) && isRange) {
      const orientation = initialField?.tableOrientation ?? tableOrientation;
      const guessed = orientation === 'vertical'
        ? guessTableRows(effectiveNormalized, sheetData)
        : guessTableColumns(effectiveNormalized, sheetData);
      const existing = filterMappingsForOrientation(initialField?.columns ?? {}, orientation);
      return {
        ...guessed,
        ...existing,
      };
    }
    return {};
  });

  useEffect(() => {
    if (parsedReference?.openEnded) {
      setOpenEnded(true);
    }
  }, [parsedReference?.openEnded]);

  const ref = parsedReference
    ? (
      parsedReference.isRange
        ? formatRange(effectiveNormalized.start, effectiveNormalized.end, openEnded)
        : formatAddress(parsedReference.start)
    )
    : referenceInput.trim();

  const effectiveSheetName = parsedReference?.sheetName ?? activeSheet;
  const sheetQualifiedRef =
    effectiveSheetName !== defaultSheet ? `${effectiveSheetName}!${ref}` : ref;
  const mappedValuePreview = summarizeMappingValues(columns);
  const rangeHeight = effectiveNormalized.end.row - effectiveNormalized.start.row + 1;
  const rangeWidth = effectiveNormalized.end.col - effectiveNormalized.start.col + 1;
  const valuePreview = buildRangePreview(sheetData, effectiveNormalized, isRange);
  const previewRowCount = valuePreview.length;
  const previewColCount = Math.max(
    ...valuePreview.map((row) => row.reduce((count, cell) => count + (cell.colSpan ?? 1), 0)),
    0,
  );
  const hasClippedPreview = isRange && (rangeHeight > previewRowCount || rangeWidth > previewColCount);

  const handleTypeChange = useCallback((newType: string) => {
    setType(newType);
    if (newType === 'table') {
      setOpenEnded(true);
      if (tableOrientation === 'horizontal') {
        setColumns((prev) => ({
          ...guessTableColumns(effectiveNormalized, sheetData),
          ...filterMappingsForOrientation(prev, 'horizontal'),
        }));
      } else {
        setColumns((prev) => ({
          ...guessTableRows(effectiveNormalized, sheetData),
          ...filterMappingsForOrientation(prev, 'vertical'),
        }));
      }
    }
  }, [effectiveNormalized, sheetData, tableOrientation]);

  useEffect(() => {
    if (type !== 'table' || !isRange) return;
    const guessed = tableOrientation === 'vertical'
      ? guessTableRows(effectiveNormalized, sheetData)
      : guessTableColumns(effectiveNormalized, sheetData);
    setColumns((prev) => {
      const next = {
        ...guessed,
        ...filterMappingsForOrientation(prev, tableOrientation),
      };
      return mappingsEqual(prev, next) ? prev : next;
    });
  }, [type, isRange, tableOrientation, effectiveNormalized, sheetData]);

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      if (!name.trim()) return;
      if (!parsedReference) {
        setReferenceError('Enter a valid Excel cell or range reference.');
        return;
      }
      if (expectedRefKind === 'range' && !parsedReference.isRange) {
        setReferenceError('This field needs a range reference.');
        return;
      }
      if (expectedRefKind === 'cell' && parsedReference.isRange) {
        setReferenceError('This field needs a single-cell reference.');
        return;
      }
      if (type === 'table' && !parsedReference.isRange) {
        setReferenceError('Table fields must use a range reference.');
        return;
      }
      setReferenceError(null);

      const field: StencilField = { name: name.trim() };

      if (isComputed) {
        field.computed = computed;
      } else if (parsedReference.isRange) {
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
    [name, parsedReference, expectedRefKind, isComputed, computed, sheetQualifiedRef, type, openEnded, tableOrientation, columns, onSave],
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  return (
    <Sheet open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onCancel(); }}>
      <SheetContent
        side="right"
        className="w-full border-l border-border bg-elevated p-0 text-text sm:max-w-xl"
      >
        <SheetHeader className="border-b border-border px-6 py-5 text-left">
          <SheetTitle className="text-lg font-semibold text-text">
            {title ?? (initialField ? 'Edit Field' : 'Define Field')}
          </SheetTitle>
          <SheetDescription className="font-mono text-sm text-text-secondary">
            {expectedRefKind === 'range' ? 'Range' : 'Cell'} field
          </SheetDescription>
        </SheetHeader>

        <form onSubmit={handleSubmit} className="flex h-full min-h-0 flex-col">
          <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
        <div className="block">
          <div className="mb-1 flex items-center justify-between gap-3">
            <Label className="text-sm text-text-secondary">Preview</Label>
            {!isComputed && (
              <span className="text-[11px] font-mono text-text-muted">
                {isRange ? `${rangeWidth} x ${rangeHeight}${openEnded ? '+' : ''}` : '1 x 1'}
              </span>
            )}
          </div>
          <div className="mb-2 text-xs font-mono text-text-muted">
            {parsedReference ? sheetQualifiedRef : 'Invalid reference'}
          </div>

          {isComputed ? (
            <div className="text-xs text-text-muted">
              Computed fields do not have a live result preview in the editor yet.
            </div>
          ) : valuePreview.length === 0 ? (
            <div className="text-xs text-text-muted">
              No preview available for this selection.
            </div>
          ) : (
            <>
              <div className={isRange ? 'overflow-hidden rounded-lg border border-border bg-surface' : ''}>
                {isRange ? (
                  <div className="overflow-auto">
                    <table className="min-w-full border-collapse text-xs">
                      <tbody>
                        {valuePreview.map((row, rowIndex) => (
                          <tr key={rowIndex}>
                            {row.map((cell, cellIndex) => (
                              <td
                                key={`${rowIndex}-${cellIndex}`}
                                colSpan={cell.colSpan}
                                rowSpan={cell.rowSpan}
                                className="max-w-[140px] border border-border px-2 py-1 font-mono text-text"
                              >
                                <div className="truncate">{cell.value || '\u00A0'}</div>
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="font-mono text-sm text-text">
                    {valuePreview[0]?.[0]?.value || <span className="text-text-muted">(empty)</span>}
                  </div>
                )}
              </div>

              {type === 'table' && isRange && mappedValuePreview.length > 0 && (
                <div className="mt-3">
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-text-muted">
                    Mapped Fields
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {mappedValuePreview.map((value) => (
                      <span
                        key={value}
                        className="rounded-md border border-border bg-surface px-2 py-1 font-mono text-[11px] text-text"
                      >
                        {value}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {hasClippedPreview && (
                <div className="mt-2 text-[11px] text-text-muted">
                  Showing the first {previewRowCount} rows and {previewColCount} columns.
                </div>
              )}
            </>
          )}
        </div>

        <div className="block">
          <Label className="mb-1 text-sm text-text-secondary">Reference</Label>
          <Input
            type="text"
            value={referenceInput}
            onChange={(e) => {
              setReferenceInput(e.target.value);
              if (referenceError) setReferenceError(null);
            }}
            placeholder={expectedRefKind === 'range' ? 'Sheet1!A1:D20' : 'Sheet1!B4'}
            className={`bg-surface font-mono text-sm text-text ${referenceError ? 'border-red-400/70' : 'border-border-strong'}`}
          />
          <div className="mt-1 flex items-center justify-between gap-3">
            <span className="text-xs font-mono text-text-muted">
              {parsedReference ? `Saving as ${sheetQualifiedRef}` : 'Enter A1 or A1:D20 style references'}
            </span>
            <Button
              type="button"
              onClick={() => {
                setReferenceInput(initialReference);
                setReferenceError(null);
                setOpenEnded(initialField?.openEnded ?? false);
              }}
              variant="ghost"
              size="xs"
              className="text-xs text-text-secondary hover:text-text"
            >
              Reset
            </Button>
          </div>
          {referenceError && (
            <p className="mt-2 text-xs text-red-300">{referenceError}</p>
          )}
        </div>

        {/* Field name */}
        <div className="block">
          <Label className="mb-1 text-sm text-text-secondary">Field Name</Label>
          <div className="relative">
            <Input
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setShowSuggestions(true);
              }}
              onFocus={() => setShowSuggestions(true)}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
              placeholder="field_name"
              className="bg-surface font-mono text-sm text-text"
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
                <Button
                  key={n}
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start rounded-none px-3 text-sm font-mono text-text hover:bg-surface"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setName(n);
                    setShowSuggestions(false);
                  }}
                >
                  {n}
                </Button>
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
        <label className="flex items-center gap-2 cursor-pointer">
          <Checkbox
            checked={isComputed}
            onCheckedChange={(checked) => setIsComputed(Boolean(checked))}
          />
          <span className="text-sm text-text-secondary">Computed field</span>
        </label>

        {isComputed ? (
          <div className="block">
            <Label className="mb-1 text-sm text-text-secondary">Expression</Label>
            <Input
              type="text"
              value={computed}
              onChange={(e) => setComputed(e.target.value)}
              placeholder='{first_name} {last_name}'
              className="bg-surface font-mono text-sm text-text"
            />
          </div>
        ) : (
          <>
            {/* Type */}
            <div className="block">
              <Label className="mb-1 text-sm text-text-secondary">Type</Label>
              <Select
                value={type}
                onValueChange={handleTypeChange}
              >
                <SelectTrigger className="w-full bg-surface text-sm text-text">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FIELD_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Open-ended range */}
            {isRange && (
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={openEnded}
                  onCheckedChange={(checked) => setOpenEnded(Boolean(checked))}
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
              <div className="block">
                <Label className="mb-1 text-sm text-text-secondary">Orientation</Label>
                <Select
                  value={tableOrientation}
                  onValueChange={(value: string) => setTableOrientation(value as 'horizontal' | 'vertical')}
                >
                  <SelectTrigger className="w-full bg-surface text-sm text-text">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="horizontal">Horizontal (headers on top)</SelectItem>
                    <SelectItem value="vertical">Vertical (headers on left)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Table columns */}
            {type === 'table' && isRange && tableOrientation === 'horizontal' && (
              <div>
                <span className="text-sm text-text-secondary mb-2 block">Column Mapping</span>
                <div className="space-y-2">
                  {horizontalColumnGroups.map((group) => (
                    <div key={`${group.startCol}-${group.endCol}`} className="flex items-center gap-2">
                      <span className="text-sm text-text-secondary font-mono w-12">
                        {formatColumnGroupLabel(group)}
                      </span>
                      <Input
                        type="text"
                        value={getColumnGroupValue(columns, group)}
                        onChange={(e) =>
                          setColumns((prev) => setColumnGroupValue(prev, group, e.target.value))
                        }
                        placeholder="column_name"
                        className="h-8 flex-1 bg-surface font-mono text-sm text-text"
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {type === 'table' && isRange && tableOrientation === 'vertical' && (
              <div>
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
                          <Input
                            type="text"
                            value={columns[rowKey] ?? ''}
                            onChange={(e) =>
                              setColumns((prev) => ({
                                ...prev,
                                [rowKey]: e.target.value,
                              }))
                            }
                            placeholder="field_name"
                            className="h-8 flex-1 bg-surface font-mono text-sm text-text"
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
          </div>

          <SheetFooter className="border-t border-border bg-elevated px-6 py-4 sm:flex-row sm:justify-end">
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim()}>
              {initialField ? 'Update Field' : 'Add Field'}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
