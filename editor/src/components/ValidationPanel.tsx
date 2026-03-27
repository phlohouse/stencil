import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import type { StencilField, StencilValidation } from '../lib/types';
import type { Workbook } from '../lib/excel';
import { getSheetData } from '../lib/excel';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { letterToColIndex, parseAddress } from '../lib/addressing';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';

interface ValidationPanelProps {
  fields: StencilField[];
  validation: Record<string, StencilValidation>;
  workbook: Workbook | null;
  defaultSheet: string;
  onSetValidation: (fieldName: string, validation: StencilValidation) => void;
  onRemoveValidation: (fieldName: string) => void;
}

interface ParsedFieldRef {
  sheetName: string;
  start: { col: number; row: number };
  end: { col: number; row: number };
  openEnded: boolean;
}

interface ValidationSuggestionEntry {
  fieldName: string;
  validation: StencilValidation;
}

function splitSheetRef(ref: string, defaultSheet: string): { sheetName: string; value: string } {
  const bangIndex = ref.indexOf('!');
  if (bangIndex < 0) {
    return { sheetName: defaultSheet, value: ref };
  }

  return {
    sheetName: ref.slice(0, bangIndex).trim() || defaultSheet,
    value: ref.slice(bangIndex + 1).trim(),
  };
}

function parseFieldRef(ref: string | undefined, defaultSheet: string): ParsedFieldRef | null {
  if (!ref) return null;
  const { sheetName, value } = splitSheetRef(ref, defaultSheet);
  const [startRef, endRefMaybe] = value.toUpperCase().split(':');

  try {
    const start = parseAddress(startRef);
    if (!endRefMaybe) {
      return { sheetName, start, end: start, openEnded: false };
    }

    const openEndedMatch = endRefMaybe.match(/^([A-Z]+)$/);
    if (openEndedMatch) {
      return {
        sheetName,
        start,
        end: { col: letterToColIndex(openEndedMatch[1]), row: start.row },
        openEnded: true,
      };
    }

    const end = parseAddress(endRefMaybe);
    return { sheetName, start, end, openEnded: false };
  } catch {
    return null;
  }
}

function collectFieldValues(field: StencilField, workbook: Workbook, defaultSheet: string): string[] {
  const ref = parseFieldRef(field.cell ?? field.range, defaultSheet);
  if (!ref) return [];

  try {
    const sheetData = getSheetData(workbook, ref.sheetName);
    const maxRow = ref.openEnded ? sheetData.rows - 1 : ref.end.row;
    const values: string[] = [];

    for (let row = ref.start.row; row <= maxRow && row < sheetData.rows; row += 1) {
      let sawContentInOpenEndedRow = false;
      for (let col = ref.start.col; col <= ref.end.col && col < sheetData.cols; col += 1) {
        const raw = sheetData.data[row]?.[col];
        const value = raw == null ? '' : String(raw).trim();
        if (value) {
          sawContentInOpenEndedRow = true;
          values.push(value);
        }
      }

      if (ref.openEnded && !sawContentInOpenEndedRow) {
        break;
      }
    }

    return values;
  } catch {
    return [];
  }
}

function inferPattern(values: string[]): string | undefined {
  if (values.length === 0) return undefined;

  const patterns = [
    { regex: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, pattern: '^[0-9a-fA-F-]{36}$' },
    { regex: /^\d{4}-\d{2}-\d{2}$/, pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    { regex: /^\d{1,2}\/\d{1,2}\/\d{4}$/, pattern: '^\\d{1,2}\\/\\d{1,2}\\/\\d{4}$' },
    { regex: /^[A-Z0-9_-]+$/, pattern: '^[A-Z0-9_-]+$' },
    { regex: /^[a-z0-9_]+$/, pattern: '^[a-z0-9_]+$' },
    { regex: /^[A-Za-z0-9_-]+$/, pattern: '^[A-Za-z0-9_-]+$' },
  ];

  const matched = patterns.find(({ regex }) => values.every((value) => regex.test(value)));
  return matched?.pattern;
}

function suggestValidationForField(
  field: StencilField,
  workbook: Workbook,
  defaultSheet: string,
): StencilValidation | null {
  if (field.computed || field.type === 'table') return null;

  const values = collectFieldValues(field, workbook, defaultSheet);
  if (values.length === 0) return null;

  const next: StencilValidation = {};
  next.required = values.length > 0;

  const numericValues = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  if (numericValues.length === values.length) {
    next.min = Math.min(...numericValues);
    next.max = Math.max(...numericValues);
    return next;
  }

  const pattern = inferPattern(values);
  if (pattern) {
    next.pattern = pattern;
  }

  return Object.keys(next).length > 0 ? next : null;
}

export function ValidationPanel({
  fields,
  validation,
  workbook,
  defaultSheet,
  onSetValidation,
  onRemoveValidation,
}: ValidationPanelProps) {
  const REQUIRED_UNSET = '__unset__';
  const [expanded, setExpanded] = useState(false);
  const [selectedField, setSelectedField] = useState('');
  const [suggestionMessage, setSuggestionMessage] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<ValidationSuggestionEntry[]>([]);
  const [previewFieldName, setPreviewFieldName] = useState<string | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);

  const validatableFields = useMemo(
    () => fields.filter((field) => !field.computed),
    [fields],
  );
  const previewSuggestion = useMemo(
    () => suggestions.find((entry) => entry.fieldName === previewFieldName) ?? null,
    [previewFieldName, suggestions],
  );
  const displayedValidation = selectedField
    ? {
        ...(validation[selectedField] ?? {}),
        ...(previewSuggestion?.fieldName === selectedField ? previewSuggestion.validation : {}),
      }
    : {};

  const handleUpdate = useCallback(
    (fieldName: string, key: keyof StencilValidation, value: string) => {
      const preview = previewFieldName === fieldName
        ? suggestions.find((entry) => entry.fieldName === fieldName)?.validation
        : undefined;
      const current = { ...(validation[fieldName] ?? {}), ...(preview ?? {}) };
      const updated = { ...current };

      if (key === 'min' || key === 'max') {
        if (value === '') {
          delete updated[key];
        } else {
          updated[key] = parseFloat(value);
        }
      } else if (key === 'pattern') {
        if (value === '') {
          delete updated[key];
        } else {
          updated[key] = value;
        }
      } else if (key === 'required') {
        updated[key] = value === 'true';
      }

      const hasValues = Object.keys(updated).length > 0;
      if (hasValues) {
        onSetValidation(fieldName, updated);
      } else {
        onRemoveValidation(fieldName);
      }
      setPreviewFieldName((currentField) => currentField === fieldName ? null : currentField);
      setSuggestions((currentSuggestions) => currentSuggestions.filter((entry) => entry.fieldName !== fieldName));
    },
    [onRemoveValidation, onSetValidation, previewFieldName, suggestions, validation],
  );

  const handleSuggestRules = useCallback(() => {
    if (!workbook) {
      setSuggestionMessage('Load a workbook to suggest validation rules.');
      setSuggestions([]);
      return;
    }

    const nextSuggestions: ValidationSuggestionEntry[] = [];
    for (const field of fields) {
      const suggestion = suggestValidationForField(field, workbook, defaultSheet);
      if (!suggestion) continue;
      nextSuggestions.push({
        fieldName: field.name,
        validation: suggestion,
      });
    }

    setSuggestions(nextSuggestions);
    setPreviewFieldName(null);
    setSuggestionMessage(
      nextSuggestions.length > 0
        ? `Found ${nextSuggestions.length} validation suggestion${nextSuggestions.length === 1 ? '' : 's'}.`
        : 'No confident validation suggestions found.',
    );
  }, [defaultSheet, fields, workbook]);

  const applySuggestion = useCallback((entry: ValidationSuggestionEntry) => {
    onSetValidation(entry.fieldName, {
      ...validation[entry.fieldName],
      ...entry.validation,
    });
    setSelectedField(entry.fieldName);
    setPreviewFieldName(null);
    setSuggestions((current) => current.filter((item) => item.fieldName !== entry.fieldName));
  }, [onSetValidation, validation]);

  const applyAllSuggestions = useCallback(() => {
    if (suggestions.length === 0) return;
    for (const entry of suggestions) {
      onSetValidation(entry.fieldName, {
        ...validation[entry.fieldName],
        ...entry.validation,
      });
    }
    setSelectedField(suggestions[0].fieldName);
    setPreviewFieldName(null);
    setSuggestionMessage(
      `Applied ${suggestions.length} validation suggestion${suggestions.length === 1 ? '' : 's'}.`,
    );
    setSuggestions([]);
  }, [onSetValidation, suggestions, validation]);

  const dismissSuggestion = useCallback((fieldName: string) => {
    setSuggestions((current) => current.filter((item) => item.fieldName !== fieldName));
    setPreviewFieldName((currentField) => currentField === fieldName ? null : currentField);
  }, []);

  const formatSuggestionBits = useCallback((rules: StencilValidation) => {
    const bits: string[] = [];
    if (rules.required !== undefined) {
      bits.push(rules.required ? 'required' : 'optional');
    }
    if (rules.min !== undefined) {
      bits.push(`min ${rules.min}`);
    }
    if (rules.max !== undefined) {
      bits.push(`max ${rules.max}`);
    }
    if (rules.pattern) {
      bits.push(`pattern ${rules.pattern}`);
    }
    return bits;
  }, []);

  useEffect(() => {
    if (!previewFieldName) return;
    editorRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [previewFieldName]);

  return (
    <div className="border-t border-border shrink-0">
      <Button
        onClick={() => setExpanded(!expanded)}
        variant="ghost"
        className="h-auto w-full justify-between rounded-none px-3 py-2 text-xs font-medium text-text-secondary hover:text-text"
      >
        <span>Validation Rules</span>
        <svg
          className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </Button>

      {expanded && (
        <div className="max-h-96 overflow-y-auto px-4 pb-3 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="text-xs"
                onClick={handleSuggestRules}
                disabled={!workbook || validatableFields.length === 0}
              >
                Suggest Rules
              </Button>
              {suggestions.length > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="text-xs"
                  onClick={applyAllSuggestions}
                >
                  Apply All
                </Button>
              )}
            </div>
            {suggestionMessage && (
              <span className="text-[11px] text-text-muted">
                {suggestionMessage}
              </span>
            )}
          </div>

          {suggestions.length > 0 && (
            <div className="space-y-2">
              {suggestions.map((entry) => (
                <div
                  key={entry.fieldName}
                  className="rounded-lg border border-border bg-bg/40 px-3 py-2"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-text">
                        {entry.fieldName}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {formatSuggestionBits(entry.validation).map((bit) => (
                          <span
                            key={bit}
                            className="rounded-sm bg-surface px-1.5 py-0.5 font-mono text-[10px] text-text-secondary"
                          >
                            {bit}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        className="text-[10px]"
                        onClick={() => {
                          setSelectedField(entry.fieldName);
                          setPreviewFieldName(entry.fieldName);
                        }}
                      >
                        View
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        className="text-[10px]"
                        onClick={() => applySuggestion(entry)}
                      >
                        Apply
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        className="px-1.5 text-[10px] text-text-muted hover:text-text"
                        onClick={() => dismissSuggestion(entry.fieldName)}
                      >
                        ×
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          <Select
            value={selectedField}
            onValueChange={setSelectedField}
            disabled={validatableFields.length === 0}
          >
            <SelectTrigger className="w-full bg-surface text-xs">
              <SelectValue placeholder="Select a field..." />
            </SelectTrigger>
            <SelectContent>
              {validatableFields.map((f) => (
                <SelectItem key={f.name} value={f.name}>
                  {f.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {validatableFields.length === 0 && (
            <div className="rounded-lg border border-border bg-bg/40 px-3 py-3 text-xs text-text-muted">
              Add a non-computed field to define validation rules.
            </div>
          )}

          {selectedField && (
            <div ref={editorRef} className="space-y-2">
              {previewSuggestion?.fieldName === selectedField && (
                <div className="rounded-md border border-border bg-bg/40 px-3 py-2 text-[11px] text-text-muted">
                  Previewing suggested rules for {selectedField}. Apply to keep them.
                </div>
              )}
              <div className="flex items-center gap-2">
                <Label className="w-14 text-xs text-text-secondary">Min</Label>
                <Input
                  type="number"
                  value={displayedValidation.min ?? ''}
                  onChange={(e) => handleUpdate(selectedField, 'min', e.target.value)}
                  className="h-8 flex-1 bg-surface text-xs font-mono"
                />
              </div>
              <div className="flex items-center gap-2">
                <Label className="w-14 text-xs text-text-secondary">Max</Label>
                <Input
                  type="number"
                  value={displayedValidation.max ?? ''}
                  onChange={(e) => handleUpdate(selectedField, 'max', e.target.value)}
                  className="h-8 flex-1 bg-surface text-xs font-mono"
                />
              </div>
              <div className="flex items-center gap-2">
                <Label className="w-14 text-xs text-text-secondary">Pattern</Label>
                <Input
                  type="text"
                  value={displayedValidation.pattern ?? ''}
                  onChange={(e) => handleUpdate(selectedField, 'pattern', e.target.value)}
                  placeholder="^[A-Za-z]+$"
                  className="h-8 flex-1 bg-surface text-xs font-mono"
                />
              </div>
              <div className="flex items-center gap-2">
                <Label className="w-14 text-xs text-text-secondary">Required</Label>
                <Select
                  value={String(displayedValidation.required ?? REQUIRED_UNSET)}
                  onValueChange={(value) => handleUpdate(selectedField, 'required', value === REQUIRED_UNSET ? '' : value)}
                >
                  <SelectTrigger className="h-8 flex-1 bg-surface text-xs">
                    <SelectValue placeholder="-" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={REQUIRED_UNSET}>-</SelectItem>
                    <SelectItem value="true">Yes</SelectItem>
                    <SelectItem value="false">No</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
