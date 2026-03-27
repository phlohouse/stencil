import { useState } from 'react';
import type { StencilField } from '../lib/types';
import { Button } from './ui/button';

interface FieldPanelProps {
  fields: StencilField[];
  defaultSheet?: string;
  onRemoveField: (name: string) => void;
  onHighlightField: (field: StencilField) => void;
  onEditField: (field: StencilField) => void;
}

interface FieldListEntry {
  field: StencilField;
  sheetName: string;
}

const COMPUTED_SECTION = 'Computed';

function getFieldSheetName(field: StencilField, defaultSheet: string): string {
  const ref = field.cell ?? field.range;
  if (!ref) return COMPUTED_SECTION;

  const bangIndex = ref.indexOf('!');
  if (bangIndex < 0) return defaultSheet;

  const sheetName = ref.slice(0, bangIndex).trim();
  return sheetName || defaultSheet;
}

function compareFieldEntries(a: { sheetName: string; field: StencilField }, b: { sheetName: string; field: StencilField }): number {
  if (a.sheetName !== b.sheetName) {
    if (a.sheetName === COMPUTED_SECTION) return 1;
    if (b.sheetName === COMPUTED_SECTION) return -1;
    return a.sheetName.localeCompare(b.sheetName, undefined, { sensitivity: 'base' });
  }

  return a.field.name.localeCompare(b.field.name, undefined, { sensitivity: 'base' });
}

function groupBySheet<T extends { sheetName: string }>(entries: T[]): Array<{ sheetName: string; entries: T[] }> {
  const groups = new Map<string, T[]>();

  for (const entry of entries) {
    const existing = groups.get(entry.sheetName);
    if (existing) {
      existing.push(entry);
    } else {
      groups.set(entry.sheetName, [entry]);
    }
  }

  return Array.from(groups.entries()).map(([sheetName, groupedEntries]) => ({
    sheetName,
    entries: groupedEntries,
  }));
}

export function FieldPanel({
  fields,
  defaultSheet = 'Sheet1',
  onRemoveField,
  onHighlightField,
  onEditField,
}: FieldPanelProps) {
  const [expanded, setExpanded] = useState(true);

  const sortedFields: FieldListEntry[] = [...fields]
    .map((field) => ({
      field,
      sheetName: getFieldSheetName(field, defaultSheet),
    }))
    .sort(compareFieldEntries);

  const groupedFields = groupBySheet(sortedFields);

  return (
    <div className="bg-surface flex h-full w-full min-h-0 flex-col overflow-hidden">
      <Button
        onClick={() => setExpanded(!expanded)}
        variant="ghost"
        className="h-auto w-full justify-between rounded-none border-b border-border px-3 py-2 text-left hover:text-text"
      >
        <span className="text-xs font-medium text-text-secondary">Fields ({fields.length})</span>
        <svg
          className={`w-3.5 h-3.5 text-text-secondary transition-transform ${expanded ? 'rotate-90' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </Button>

      {expanded && (
        <div className="min-h-0 flex-1 overflow-y-auto py-1 space-y-0.5">
          {fields.length === 0 ? (
            <div className="min-h-24 flex items-center justify-center rounded-lg border border-border bg-bg/40 px-3 text-center">
              <p className="text-xs text-text-muted">
                Select cells to define fields
              </p>
            </div>
          ) : (
            groupedFields.map((group) => (
              <div key={group.sheetName} className="space-y-0.5">
                <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted">
                  {group.sheetName}
                </div>
                {group.entries.map(({ field }) => (
                  <div
                    key={field.name}
                    className="group relative cursor-pointer px-3 py-1.5 transition-colors hover:bg-muted/70"
                    onClick={() => onHighlightField(field)}
                  >
                    <div className="flex items-center gap-2 pr-2">
                      <span className="min-w-0 flex-1 text-xs font-medium text-text truncate">
                        {field.name}
                      </span>
                      <span className="max-w-[140px] text-[10px] font-mono text-emerald-700 dark:text-emerald-300/80 truncate">
                        {field.computed
                          ? field.computed
                          : field.cell ?? field.range ?? ''}
                      </span>
                    </div>
                    <div className="absolute inset-y-0 right-2 flex items-center gap-1 bg-muted/90 pl-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                      <Button
                        onClick={(e) => {
                          e.stopPropagation();
                          onEditField(field);
                        }}
                        variant="ghost"
                        size="xs"
                        className="px-1.5 text-[10px] text-text-secondary hover:text-text"
                      >
                        Edit
                      </Button>
                      <Button
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemoveField(field.name);
                        }}
                        variant="ghost"
                        size="xs"
                        className="px-1.5 text-[10px] text-text-muted hover:text-red-300"
                      >
                        ×
                      </Button>
                    </div>
                    {field.computed && (
                      <div className="mt-1 text-[10px] uppercase tracking-wide text-text-muted">
                        Computed
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
