import { useState } from 'react';
import type { StencilField } from '../lib/types';

interface FieldPanelProps {
  fields: StencilField[];
  onRemoveField: (name: string) => void;
  onHighlightField: (field: StencilField) => void;
}

export function FieldPanel({
  fields,
  onRemoveField,
  onHighlightField,
}: FieldPanelProps) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div
      className={`border-l border-gray-700 bg-gray-900 flex flex-col transition-all ${
        collapsed ? 'w-10' : 'w-72'
      }`}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700">
        {!collapsed && (
          <h3 className="text-sm font-semibold text-gray-200">Fields</h3>
        )}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="text-gray-400 hover:text-white p-1 transition-colors"
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
            <p className="text-xs text-gray-500 p-2 text-center">
              Select cells to define fields
            </p>
          ) : (
            fields.map((field) => (
              <div
                key={field.name}
                className="group flex items-center justify-between px-3 py-2 rounded-lg hover:bg-gray-800 cursor-pointer transition-colors"
                onClick={() => onHighlightField(field)}
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-gray-200 truncate">
                    {field.name}
                  </div>
                  <div className="text-xs text-gray-500 font-mono truncate">
                    {field.computed
                      ? `computed: ${field.computed}`
                      : field.cell ?? field.range ?? ''}
                    {field.type && !field.computed && (
                      <span className="text-gray-600"> · {field.type}</span>
                    )}
                  </div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveField(field.name);
                  }}
                  className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400 p-1 transition-all"
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
            ))
          )}
        </div>
      )}
    </div>
  );
}
