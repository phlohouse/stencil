import { useState } from 'react';
import type { StencilField } from '../lib/types';

interface FieldPanelProps {
  fields: StencilField[];
  onRemoveField: (name: string) => void;
  onHighlightField: (field: StencilField) => void;
  onRenameField: (field: StencilField) => void;
}

export function FieldPanel({
  fields,
  onRemoveField,
  onHighlightField,
  onRenameField,
}: FieldPanelProps) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div
      className="border-l border-border bg-surface flex flex-col w-full"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        {!collapsed && (
          <h3 className="text-sm font-semibold text-text-secondary">Fields</h3>
        )}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="text-text-secondary hover:text-text p-1 transition-colors"
          title={collapsed ? 'Expand panel' : 'Collapse panel'}
        >
          <svg
            className={`w-4 h-4 transition-transform ${collapsed ? 'rotate-180' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      {!collapsed && (
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
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
                className="group flex items-center justify-between px-3 py-2 rounded-lg hover:bg-elevated cursor-pointer transition-colors"
                onClick={() => onHighlightField(field)}
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-text-secondary truncate">
                    {field.name}
                  </div>
                  <div className="text-xs text-text-muted font-mono truncate">
                    {field.computed
                      ? `computed: ${field.computed}`
                      : field.cell ?? field.range ?? ''}
                    {field.type && !field.computed && (
                      <span className="text-text-faint"> · {field.type}</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center opacity-0 group-hover:opacity-100 transition-all">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onRenameField(field);
                    }}
                    className="text-text-muted hover:text-accent p-1 transition-colors"
                    title="Rename field"
                  >
                    <svg
                      className="w-3.5 h-3.5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536M9 11l6.768-6.768a2.5 2.5 0 113.536 3.536L12.536 14.536A4 4 0 019.707 15.707L6 16l.293-3.707A4 4 0 017.464 9.464L9 8" />
                    </svg>
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemoveField(field.name);
                    }}
                    className="text-text-muted hover:text-red-400 p-1 transition-colors"
                    title="Remove field"
                  >
                    <svg
                      className="w-3.5 h-3.5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
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
