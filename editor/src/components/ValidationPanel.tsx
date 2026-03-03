import { useState, useCallback } from 'react';
import type { StencilField, StencilValidation } from '../lib/types';

interface ValidationPanelProps {
  fields: StencilField[];
  validation: Record<string, StencilValidation>;
  onSetValidation: (fieldName: string, validation: StencilValidation) => void;
  onRemoveValidation: (fieldName: string) => void;
}

export function ValidationPanel({
  fields,
  validation,
  onSetValidation,
  onRemoveValidation,
}: ValidationPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [selectedField, setSelectedField] = useState('');

  const handleUpdate = useCallback(
    (fieldName: string, key: keyof StencilValidation, value: string) => {
      const current = validation[fieldName] ?? {};
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
    },
    [validation, onSetValidation, onRemoveValidation],
  );

  if (fields.length === 0) return null;

  return (
    <div className="border-t border-gray-700">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-2 text-xs font-medium text-gray-400 hover:text-gray-200 transition-colors"
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
      </button>

      {expanded && (
        <div className="px-4 pb-3 space-y-3">
          <select
            value={selectedField}
            onChange={(e) => setSelectedField(e.target.value)}
            className="w-full px-2 py-1.5 bg-gray-900 border border-gray-600 rounded text-xs text-white focus:outline-none focus:border-blue-500"
          >
            <option value="">Select a field…</option>
            {fields
              .filter((f) => !f.computed)
              .map((f) => (
                <option key={f.name} value={f.name}>
                  {f.name}
                </option>
              ))}
          </select>

          {selectedField && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-400 w-14">Min</label>
                <input
                  type="number"
                  value={validation[selectedField]?.min ?? ''}
                  onChange={(e) => handleUpdate(selectedField, 'min', e.target.value)}
                  className="flex-1 px-2 py-1 bg-gray-900 border border-gray-600 rounded text-xs text-white font-mono focus:outline-none focus:border-blue-500"
                />
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-400 w-14">Max</label>
                <input
                  type="number"
                  value={validation[selectedField]?.max ?? ''}
                  onChange={(e) => handleUpdate(selectedField, 'max', e.target.value)}
                  className="flex-1 px-2 py-1 bg-gray-900 border border-gray-600 rounded text-xs text-white font-mono focus:outline-none focus:border-blue-500"
                />
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-400 w-14">Pattern</label>
                <input
                  type="text"
                  value={validation[selectedField]?.pattern ?? ''}
                  onChange={(e) => handleUpdate(selectedField, 'pattern', e.target.value)}
                  placeholder="^[A-Za-z]+$"
                  className="flex-1 px-2 py-1 bg-gray-900 border border-gray-600 rounded text-xs text-white font-mono focus:outline-none focus:border-blue-500"
                />
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-400 w-14">Required</label>
                <select
                  value={String(validation[selectedField]?.required ?? '')}
                  onChange={(e) => handleUpdate(selectedField, 'required', e.target.value)}
                  className="flex-1 px-2 py-1 bg-gray-900 border border-gray-600 rounded text-xs text-white focus:outline-none focus:border-blue-500"
                >
                  <option value="">—</option>
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </select>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
