import { useMemo, useState } from 'react';
import { findSchemaProblems } from '../lib/problems';
import type { StencilField, StencilVersion } from '../lib/types';
import { Button } from './ui/button';

interface ProblemsPanelProps {
  activeFields: StencilField[];
  versions: StencilVersion[];
  activeVersionDiscriminatorValue?: string;
  defaultSheet: string;
  onHighlightField: (field: StencilField) => void;
}

const KIND_LABELS: Record<string, string> = {
  overlap: 'Overlapping fields',
  'table-columns': 'Table mapping',
  'version-key': 'Versions',
  discriminator: 'Versions',
};

export function ProblemsPanel({
  activeFields,
  versions,
  activeVersionDiscriminatorValue,
  defaultSheet,
  onHighlightField,
}: ProblemsPanelProps) {
  const [expanded, setExpanded] = useState(false);

  const problems = useMemo(
    () => findSchemaProblems(activeFields, versions, activeVersionDiscriminatorValue, defaultSheet),
    [activeFields, versions, activeVersionDiscriminatorValue, defaultSheet],
  );

  return (
    <div className="border-t border-border shrink-0">
      <Button
        onClick={() => setExpanded(!expanded)}
        variant="ghost"
        className="h-auto w-full justify-between rounded-none px-3 py-2 text-xs font-medium text-text-secondary hover:text-text"
      >
        <span>
          Problems
          {problems.length > 0 && (
            <span className="ml-2 rounded bg-amber-500/20 px-1.5 py-0.5 text-[11px] text-amber-200">
              {problems.length}
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
          {problems.length === 0 ? (
            <p className="text-[11px] text-text-muted">
              No overlapping fields, table mappings or version clashes found in this version.
            </p>
          ) : (
            problems.map((problem) => {
              const field = problem.fieldNames.length > 0
                ? activeFields.find((entry) => entry.name === problem.fieldNames[0])
                : undefined;

              return (
                <div
                  key={`${problem.kind}:${problem.message}`}
                  className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5"
                >
                  <div className="text-[11px] uppercase tracking-wide text-amber-200/80">
                    {KIND_LABELS[problem.kind] ?? problem.kind}
                  </div>
                  <div className="text-xs text-amber-100">{problem.message}</div>
                  {field && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="mt-1 px-0 text-[11px] text-amber-200 hover:text-amber-100"
                      onClick={() => onHighlightField(field)}
                    >
                      Show {field.name}
                    </Button>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
