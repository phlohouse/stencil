import { useState } from 'react';
import type { StencilField } from '../lib/types';

interface FieldPanelProps {
  fields: StencilField[];
  onRemoveField: (name: string) => void;
  onHighlightField: (field: StencilField) => void;
  onEditField: (field: StencilField) => void;
}

export function FieldPanel({
  fields,
  onRemoveField,
  onHighlightField,
  onEditField,
}: FieldPanelProps) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="bg-surface flex flex-col w-full min-h-0 shrink-0">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3 py-2 border-b border-border text-left hover:text-text transition-colors"
      >
        <span className="text-xs font-medium text-text-secondary">Fields</span>
        <svg
          className={`w-3.5 h-3.5 text-text-secondary transition-transform ${expanded ? 'rotate-90' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </button>

      {expanded && (
        <div className="max-h-[45vh] overflow-y-auto p-2 space-y-2">
          {fields.length === 0 ? (
            <div className="min-h-24 flex items-center justify-center rounded-lg border border-border bg-bg/40 px-3 text-center">
              <p className="text-xs text-text-muted">
                Select cells to define fields
              </p>
            </div>
          ) : (
            fields.map((field) => (
              <div
                key={field.name}
                className="rounded-lg border border-border bg-bg/70 hover:bg-surface p-3 cursor-pointer transition-colors overflow-hidden"
                onClick={() => onHighlightField(field)}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-xs uppercase tracking-wide text-text-muted">
                      {field.type ?? (field.computed ? 'computed' : 'field')}
                    </div>
                    <div className="text-sm font-medium text-text truncate">
                      {field.name}
                    </div>
                    <div className="mt-1 text-[11px] font-mono text-emerald-700 dark:text-emerald-300/90 break-all">
                      {field.computed
                        ? `computed: ${field.computed}`
                        : field.cell ?? field.range ?? ''}
                    </div>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onEditField(field);
                    }}
                    className="shrink-0 px-2 py-1 rounded bg-elevated text-text-secondary text-xs font-medium border border-border hover:border-border-strong transition-colors"
                    title="Edit field"
                  >
                    Edit
                  </button>
                </div>
                <div className="mt-3 flex justify-end">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemoveField(field.name);
                    }}
                    className="text-xs text-text-muted hover:text-red-300 transition-colors"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
