import { useState, useCallback, type FormEvent } from 'react';
import type { Selection, StencilField } from '../lib/types';
import type { SheetData } from '../lib/excel';
import { FIELD_TYPES } from '../lib/types';
import { formatRange, normalizeRange, isRangeSelection, formatAddress, colIndexToLetter } from '../lib/addressing';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[()µ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
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
  const headerRow = normalized.start.row;

  for (let c = normalized.start.col; c <= normalized.end.col; c++) {
    const val = sheetData.data[headerRow]?.[c];
    const colLetter = colIndexToLetter(c);
    if (val != null && typeof val === 'string' && val.trim()) {
      columns[colLetter] = slugify(val);
    } else if (val != null && String(val).trim()) {
      columns[colLetter] = slugify(String(val));
    }
  }

  return columns;
}

interface FieldDialogProps {
  selection: Selection;
  activeSheet: string;
  defaultSheet: string;
  sheetData: SheetData | null;
  onSave: (field: StencilField) => void;
  onCancel: () => void;
}

export function FieldDialog({
  selection,
  activeSheet,
  defaultSheet,
  sheetData,
  onSave,
  onCancel,
}: FieldDialogProps) {
  const normalized = normalizeRange(selection.start, selection.end);
  const isRange = isRangeSelection(normalized.start, normalized.end);

  const [name, setName] = useState(() => suggestFieldName(selection, sheetData, isRange));
  const [type, setType] = useState(isRange ? 'list[str]' : 'str');
  const [openEnded, setOpenEnded] = useState(false);
  const [computed, setComputed] = useState('');
  const [isComputed, setIsComputed] = useState(false);
  const [columns, setColumns] = useState<Record<string, string>>({});

  const ref = isRange
    ? formatRange(normalized.start, normalized.end, openEnded)
    : formatAddress(normalized.start);

  const sheetQualifiedRef =
    activeSheet !== defaultSheet ? `${activeSheet}!${ref}` : ref;

  const handleTypeChange = useCallback((newType: string) => {
    setType(newType);
    if (newType === 'table') {
      setOpenEnded(true);
      setColumns(guessTableColumns(normalized, sheetData));
    }
  }, [normalized, sheetData]);

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
        if (type === 'table' && Object.keys(columns).length > 0) {
          field.columns = columns;
        }
      } else {
        field.cell = sheetQualifiedRef;
        if (type !== 'str') field.type = type;
      }

      onSave(field);
    },
    [name, isComputed, computed, isRange, sheetQualifiedRef, type, openEnded, columns, onSave],
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <form
        onSubmit={handleSubmit}
        className="bg-gray-800 rounded-xl border border-gray-700 p-6 w-full max-w-md shadow-2xl"
      >
        <h3 className="text-lg font-semibold text-white mb-1">Define Field</h3>
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
              <div className="mb-4">
                <span className="text-sm text-gray-300 mb-2 block">Column Mapping</span>
                <div className="space-y-2">
                  {Array.from(
                    { length: normalized.end.col - normalized.start.col + 1 },
                    (_, i) => {
                      const colLetter = String.fromCharCode(65 + normalized.start.col + i);
                      return (
                        <div key={colLetter} className="flex items-center gap-2">
                          <span className="text-sm text-gray-400 font-mono w-8">
                            {colLetter}:
                          </span>
                          <input
                            type="text"
                            value={columns[colLetter] ?? ''}
                            onChange={(e) =>
                              setColumns((prev) => ({
                                ...prev,
                                [colLetter]: e.target.value,
                              }))
                            }
                            placeholder="column_name"
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
            Add Field
          </button>
        </div>
      </form>
    </div>
  );
}
