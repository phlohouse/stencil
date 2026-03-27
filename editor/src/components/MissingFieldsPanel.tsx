import { useMemo, useState } from 'react';
import type { StencilField, StencilVersion } from '../lib/types';
import { Button } from './ui/button';

interface MissingFieldsPanelProps {
  activeFields: StencilField[];
  versions: StencilVersion[];
  activeVersionDiscriminatorValue?: string;
  defaultSheet?: string;
}

interface MissingFieldEntry {
  field: StencilField;
  sheetName: string;
  versionLabels: string[];
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

function compareMissingFields(a: MissingFieldEntry, b: MissingFieldEntry): number {
  if (a.sheetName !== b.sheetName) {
    if (a.sheetName === COMPUTED_SECTION) return 1;
    if (b.sheetName === COMPUTED_SECTION) return -1;
    return a.sheetName.localeCompare(b.sheetName, undefined, { sensitivity: 'base' });
  }

  return a.field.name.localeCompare(b.field.name, undefined, { sensitivity: 'base' });
}

export function MissingFieldsPanel({
  activeFields,
  versions,
  activeVersionDiscriminatorValue,
  defaultSheet = 'Sheet1',
}: MissingFieldsPanelProps) {
  const [expanded, setExpanded] = useState(true);

  const groupedMissingFields = useMemo(() => {
    const currentFieldNames = new Set(activeFields.map((field) => field.name));
    const missingFieldMap = new Map<string, MissingFieldEntry>();

    for (const version of versions) {
      if (version.discriminatorValue === activeVersionDiscriminatorValue) continue;

      const versionLabel = version.discriminatorValue || 'Untitled version';
      for (const field of version.fields) {
        if (currentFieldNames.has(field.name)) continue;

        const existing = missingFieldMap.get(field.name);
        if (existing) {
          if (!existing.versionLabels.includes(versionLabel)) {
            existing.versionLabels.push(versionLabel);
          }
          continue;
        }

        missingFieldMap.set(field.name, {
          field,
          sheetName: getFieldSheetName(field, defaultSheet),
          versionLabels: [versionLabel],
        });
      }
    }

    const groups = new Map<string, MissingFieldEntry[]>();
    for (const entry of Array.from(missingFieldMap.values()).sort(compareMissingFields)) {
      const group = groups.get(entry.sheetName);
      if (group) {
        group.push(entry);
      } else {
        groups.set(entry.sheetName, [entry]);
      }
    }

    return Array.from(groups.entries()).map(([sheetName, entries]) => ({
      sheetName,
      entries,
    }));
  }, [activeFields, activeVersionDiscriminatorValue, defaultSheet, versions]);

  const missingCount = groupedMissingFields.reduce((count, group) => count + group.entries.length, 0);

  return (
    <div className="border-t border-border shrink-0">
      <Button
        onClick={() => setExpanded(!expanded)}
        variant="ghost"
        className="h-auto w-full justify-between rounded-none px-3 py-2 text-xs font-medium text-text-secondary hover:text-text"
      >
        <span>Missing Fields ({missingCount})</span>
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
        <div className="px-3 pb-3 space-y-2">
          {groupedMissingFields.length === 0 ? (
            <div className="rounded-lg border border-border bg-bg/40 px-3 py-3 text-xs text-text-muted">
              This version already includes all fields seen in the other versions.
            </div>
          ) : (
            groupedMissingFields.map((group) => (
              <div key={group.sheetName} className="space-y-0.5">
                <div className="px-1 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted">
                  {group.sheetName}
                </div>
                {group.entries.map(({ field, versionLabels }) => (
                  <div
                    key={field.name}
                    className="rounded border border-dashed border-border px-2 py-1.5"
                  >
                    <div className="text-xs font-medium text-text truncate">
                      {field.name}
                    </div>
                    <div className="mt-1 text-[10px] text-text-muted">
                      {versionLabels.join(', ')}
                    </div>
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
