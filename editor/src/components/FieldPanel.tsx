import { useState } from 'react';
import type { StencilField } from '../lib/types';
import { Button } from './ui/button';

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
        <div className="overflow-y-auto p-1.5 space-y-0.5">
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
                className="group rounded border border-transparent hover:border-border hover:bg-bg/70 px-2 py-1.5 cursor-pointer transition-colors"
                onClick={() => onHighlightField(field)}
              >
                <div className="flex items-center gap-2">
                  <span className="text-[10px] uppercase tracking-wide text-text-muted w-10 shrink-0">
                    {field.type === 'table' ? 'tbl' : field.computed ? 'calc' : field.type ?? 'str'}
                  </span>
                  <span className="text-xs font-medium text-text truncate flex-1">
                    {field.name}
                  </span>
                  <span className="text-[10px] font-mono text-emerald-700 dark:text-emerald-300/80 truncate max-w-[120px]">
                    {field.computed
                      ? field.computed
                      : field.cell ?? field.range ?? ''}
                  </span>
                  <div className="hidden group-hover:flex items-center gap-1 shrink-0">
                    <Button
                      onClick={(e) => {
                        e.stopPropagation();
                        onEditField(field);
                      }}
                      variant="outline"
                      size="xs"
                      className="bg-elevated px-1.5 text-[10px] text-text-secondary hover:text-text"
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
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
