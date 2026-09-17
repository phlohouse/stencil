import { useMemo, useState } from 'react';
import { Button } from './ui/button';
import { diffVersions, type DiffStatus } from '../lib/schema-diff';
import type { StencilVersion } from '../lib/types';

interface VersionDiffPanelProps {
  versions: StencilVersion[];
  activeVersionIndex: number;
}

const STATUS_STYLES: Record<DiffStatus, string> = {
  added: 'text-emerald-600 dark:text-emerald-300',
  removed: 'text-red-600 dark:text-red-300',
  changed: 'text-amber-700 dark:text-amber-200',
  unchanged: 'text-text-muted',
};

const STATUS_LABELS: Record<DiffStatus, string> = {
  added: '+',
  removed: '-',
  changed: '~',
  unchanged: '=',
};

function versionLabel(version: StencilVersion, index: number): string {
  return version.discriminatorValue || `version ${index + 1}`;
}

export function VersionDiffPanel({ versions, activeVersionIndex }: VersionDiffPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [showUnchanged, setShowUnchanged] = useState(false);
  // Left unset until the reader picks, so the defaults follow the schema.
  const [fromChoice, setFromChoice] = useState<number | null>(null);
  const [toChoice, setToChoice] = useState<number | null>(null);

  const clampIndex = (index: number) =>
    Math.min(Math.max(0, index), Math.max(0, versions.length - 1));
  const fromIndex = clampIndex(fromChoice ?? 0);
  // Compare against the active version when it is not already the "from" one.
  const toIndex = clampIndex(
    toChoice ?? (activeVersionIndex > 0 ? activeVersionIndex : versions.length - 1),
  );

  const from = versions[fromIndex];
  const to = versions[toIndex];

  const diff = useMemo(
    () => (from && to && from !== to ? diffVersions(from, to) : null),
    [from, to],
  );

  const visibleFields = useMemo(
    () => (diff ? diff.fields.filter((field) => showUnchanged || field.status !== 'unchanged') : []),
    [diff, showUnchanged],
  );

  return (
    <div className="border-t border-border shrink-0">
      <Button
        onClick={() => setExpanded(!expanded)}
        variant="ghost"
        className="h-auto w-full justify-between rounded-none px-3 py-2 text-xs font-medium text-text-secondary hover:text-text"
      >
        <span>
          Version Diff
          {diff && (
            <span className="ml-2 text-[11px] text-text-muted">
              {diff.summary.added} added / {diff.summary.removed} removed / {diff.summary.changed} changed
            </span>
          )}
        </span>
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
        <div className="max-h-72 overflow-y-auto px-4 pb-3 space-y-2">
          {versions.length < 2 ? (
            <p className="text-[11px] text-text-muted">
              Add a second version to compare two workbook layouts.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-text-secondary">
                <label className="inline-flex items-center gap-1">
                  From
                  <select
                    value={fromIndex}
                    onChange={(event) => setFromChoice(Number(event.target.value))}
                    className="h-6 rounded border border-border bg-surface px-1 text-[11px] text-text"
                  >
                    {versions.map((version, index) => (
                      <option key={version.id ?? index} value={index}>
                        {versionLabel(version, index)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="inline-flex items-center gap-1">
                  To
                  <select
                    value={toIndex}
                    onChange={(event) => setToChoice(Number(event.target.value))}
                    className="h-6 rounded border border-border bg-surface px-1 text-[11px] text-text"
                  >
                    {versions.map((version, index) => (
                      <option key={version.id ?? index} value={index}>
                        {versionLabel(version, index)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="inline-flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={showUnchanged}
                    onChange={(event) => setShowUnchanged(event.target.checked)}
                  />
                  Show unchanged
                </label>
              </div>

              {!diff ? (
                <p className="text-[11px] text-text-muted">
                  Pick two different versions to see what changed.
                </p>
              ) : (
                (
                  <>
                    <div className="text-[11px] text-text-muted">
                      {diff.from || 'untitled'} → {diff.to || 'untitled'}
                      {diff.discriminatorChanged
                        ? ` (discriminator value changes, so workbooks still map to different versions)`
                        : ''}
                    </div>
                    {visibleFields.length === 0 ? (
                      <p className="text-[11px] text-text-muted">
                        The two versions extract the same fields.
                      </p>
                    ) : (
                      visibleFields.map((field) => (
                        <div key={field.name} className="rounded border border-border bg-surface/60 px-2 py-1.5">
                          <div className="text-xs">
                            <span className={`mr-1.5 font-mono ${STATUS_STYLES[field.status]}`}>
                              {STATUS_LABELS[field.status]}
                            </span>
                            <span className="font-mono text-text">{field.name}</span>
                          </div>
                          {field.changes.map((change) => (
                            <div key={change} className="mt-0.5 text-[11px] text-text-secondary">
                              {change}
                            </div>
                          ))}
                        </div>
                      ))
                    )}
                    {diff.validation.length > 0 && (
                      <div className="pt-1">
                        <div className="text-[11px] uppercase tracking-wide text-text-muted">
                          Validation rules
                        </div>
                        {diff.validation.map((rule) => (
                          <div key={rule.field} className="mt-1 text-[11px]">
                            <span className={`mr-1.5 font-mono ${STATUS_STYLES[rule.status]}`}>
                              {STATUS_LABELS[rule.status]}
                            </span>
                            <span className="font-mono text-text">{rule.field}</span>
                            <span className="ml-2 text-text-secondary">{rule.changes.join('; ')}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
