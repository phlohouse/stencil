import { useMemo, useState } from 'react';
import type { StencilField, StencilValidation } from '../lib/types';
import { Button } from './ui/button';
import { Input } from './ui/input';

interface FieldPanelProps {
  fields: StencilField[];
  validation?: Record<string, StencilValidation>;
  defaultSheet?: string;
  onRemoveField: (name: string) => void;
  onHighlightField: (field: StencilField) => void;
  onEditField: (field: StencilField) => void;
  onDuplicateField: (field: StencilField) => void;
  onMoveField: (name: string, delta: number) => void;
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

/** The type a reader sees on the card: declared type, or what the reference implies. */
function describeType(field: StencilField): string {
  if (field.type) return field.type;
  if (field.computed) return 'fx';
  if (field.range) return 'list';
  return 'str';
}

function describeReference(field: StencilField): string {
  if (field.computed) return field.computed;
  return field.cell ?? field.range ?? '—';
}

function describeRuleCount(validation: StencilValidation | undefined): number {
  if (!validation) return 0;
  return [validation.min, validation.max, validation.pattern].filter((value) => value != null).length;
}

export function FieldPanel({
  fields,
  validation = {},
  defaultSheet = 'Sheet1',
  onRemoveField,
  onHighlightField,
  onEditField,
  onDuplicateField,
  onMoveField,
}: FieldPanelProps) {
  const [query, setQuery] = useState('');

  const visibleFields = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return fields;
    return fields.filter((field) => [
      field.name,
      field.cell ?? '',
      field.range ?? '',
      field.computed ?? '',
      field.type ?? '',
    ].some((value) => value.toLowerCase().includes(needle)));
  }, [fields, query]);

  const groupedFields = useMemo(() => {
    const sortedFields: FieldListEntry[] = [...visibleFields]
      .map((field) => ({
        field,
        sheetName: getFieldSheetName(field, defaultSheet),
      }))
      .sort(compareFieldEntries);
    return groupBySheet(sortedFields);
  }, [visibleFields, defaultSheet]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 px-3 py-2">
        <span className="text-xs font-semibold text-text">Fields</span>
        <span className="rounded-full bg-elevated px-1.5 py-px text-[10px] text-text-secondary ring-1 ring-border">
          {fields.length}
        </span>
        <Input
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter…"
          className="ml-auto h-6 w-28 bg-surface px-2 text-[11px]"
        />
      </div>

      <div className="space-y-2 px-3 pb-3">
        {fields.length === 0 ? (
          <div className="mt-2 rounded-lg border border-dashed border-border bg-bg/40 px-3 py-6 text-center">
            <svg
              className="mx-auto mb-2 size-5 text-text-faint"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.6}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3.75 5.25h16.5M3.75 12h16.5M3.75 18.75h9"
              />
            </svg>
            <p className="text-[11px] text-text-secondary">
              Select a cell or range in the sheet to map a field.
            </p>
          </div>
        ) : groupedFields.length === 0 ? (
          <p className="px-1 py-2 text-[11px] text-text-muted">No fields match “{query.trim()}”.</p>
        ) : (
          groupedFields.map((group) => (
            <div key={group.sheetName} className="space-y-1.5">
              <div className="sticky top-0 z-10 flex items-center gap-1.5 bg-surface/95 py-1 backdrop-blur">
                <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted">
                  {group.sheetName}
                </span>
                <span className="text-[10px] text-text-faint">{group.entries.length}</span>
              </div>

              {group.entries.map(({ field }) => {
                const rules = validation[field.name];
                const ruleCount = describeRuleCount(rules);
                return (
                  <div
                    key={field.name}
                    onClick={() => onHighlightField(field)}
                    className="group cursor-pointer rounded-lg border border-border bg-bg/40 px-2.5 py-2 transition-colors hover:border-border-strong hover:bg-bg/70"
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate text-xs font-medium text-text">
                        {field.name}
                      </span>
                      {rules?.required && (
                        <span
                          className="shrink-0 text-[10px] text-accent"
                          title="Required: extraction fails when this is empty"
                        >
                          required
                        </span>
                      )}
                      {ruleCount > 0 && (
                        <span
                          className="shrink-0 rounded bg-elevated px-1 py-px text-[10px] text-text-secondary ring-1 ring-border"
                          title={`${ruleCount} validation rule${ruleCount === 1 ? '' : 's'}`}
                        >
                          {ruleCount} rule{ruleCount === 1 ? '' : 's'}
                        </span>
                      )}
                      <span className="shrink-0 rounded bg-elevated px-1.5 py-px font-mono text-[10px] text-text-secondary">
                        {describeType(field)}
                      </span>
                    </div>

                    <div className="mt-1 flex items-center gap-1.5">
                      <span
                        className="min-w-0 flex-1 truncate font-mono text-[10px] text-field"
                        title={describeReference(field)}
                      >
                        {describeReference(field)}
                      </span>
                      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                        <Button
                          onClick={(event) => {
                            event.stopPropagation();
                            onMoveField(field.name, -1);
                          }}
                          variant="ghost"
                          size="icon-xs"
                          title="Move up in the YAML order"
                          className="text-text-muted hover:text-text"
                        >
                          <svg className="size-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
                          </svg>
                        </Button>
                        <Button
                          onClick={(event) => {
                            event.stopPropagation();
                            onMoveField(field.name, 1);
                          }}
                          variant="ghost"
                          size="icon-xs"
                          title="Move down in the YAML order"
                          className="text-text-muted hover:text-text"
                        >
                          <svg className="size-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                          </svg>
                        </Button>
                        <Button
                          onClick={(event) => {
                            event.stopPropagation();
                            onEditField(field);
                          }}
                          variant="ghost"
                          size="icon-xs"
                          title="Edit field"
                          className="text-text-muted hover:text-text"
                        >
                          <svg className="size-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.862 4.487z"
                            />
                          </svg>
                        </Button>
                        <Button
                          onClick={(event) => {
                            event.stopPropagation();
                            onDuplicateField(field);
                          }}
                          variant="ghost"
                          size="icon-xs"
                          title="Duplicate field"
                          className="text-text-muted hover:text-text"
                        >
                          <svg className="size-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M8 8V5a2 2 0 012-2h9a2 2 0 012 2v9a2 2 0 01-2 2h-3" />
                            <rect x="3" y="8" width="13" height="13" rx="2" />
                          </svg>
                        </Button>
                        <Button
                          onClick={(event) => {
                            event.stopPropagation();
                            onRemoveField(field.name);
                          }}
                          variant="ghost"
                          size="icon-xs"
                          title="Remove field"
                          className="text-text-muted hover:text-red-600 dark:hover:text-red-300"
                        >
                          <svg className="size-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
