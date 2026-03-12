import { useState, useCallback } from 'react';
import type { RemapSuggestion } from '../lib/field-fingerprints';

interface RemapSuggestionsDialogProps {
  suggestions: RemapSuggestion[];
  sourceVersion: string;
  onAccept: (accepted: RemapSuggestion[]) => void;
  onDismiss: () => void;
}

export function RemapSuggestionsDialog({
  suggestions,
  sourceVersion,
  onAccept,
  onDismiss,
}: RemapSuggestionsDialogProps) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(suggestions.map((s) => s.fieldName)),
  );

  const toggleField = useCallback((fieldName: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(fieldName)) {
        next.delete(fieldName);
      } else {
        next.add(fieldName);
      }
      return next;
    });
  }, []);

  const handleAccept = useCallback(() => {
    const accepted = suggestions.filter((s) => selected.has(s.fieldName));
    onAccept(accepted);
  }, [onAccept, selected, suggestions]);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-surface border border-border rounded-lg shadow-xl w-[480px] max-h-[80vh] flex flex-col">
        <div className="px-4 py-3 border-b border-border">
          <h3 className="text-sm font-semibold text-text">Fields Have Moved</h3>
          <p className="text-xs text-text-secondary mt-1">
            Based on saved values from <span className="font-mono text-accent">{sourceVersion}</span>,
            these fields appear to have moved to new locations in the current spreadsheet.
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-2">
          {suggestions.map((s) => (
            <label
              key={s.fieldName}
              className="flex items-start gap-3 py-2 border-b border-border/50 last:border-0 cursor-pointer hover:bg-elevated/40 rounded px-1 -mx-1"
            >
              <input
                type="checkbox"
                checked={selected.has(s.fieldName)}
                onChange={() => toggleField(s.fieldName)}
                className="mt-0.5 accent-accent"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-text">{s.fieldName}</span>
                  <span className="text-xs text-text-muted">
                    {Math.round(s.confidence * 100)}% match
                  </span>
                </div>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className="text-xs font-mono text-text-secondary">{s.oldRef}</span>
                  <svg className="w-3 h-3 text-text-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
                  </svg>
                  <span className="text-xs font-mono text-green-400">{s.newRef}</span>
                </div>
                {s.matchedValues.length > 0 && (
                  <p className="text-[10px] text-text-faint mt-0.5 truncate">
                    Values: {s.matchedValues.slice(0, 3).join(', ')}
                    {s.matchedValues.length > 3 && ` (+${s.matchedValues.length - 3} more)`}
                  </p>
                )}
              </div>
            </label>
          ))}
        </div>

        <div className="px-4 py-3 border-t border-border flex items-center justify-between">
          <button
            onClick={onDismiss}
            className="px-3 py-1.5 text-xs text-text-secondary hover:text-text bg-elevated border border-border rounded transition-colors"
          >
            Skip
          </button>
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-muted">
              {selected.size} of {suggestions.length} selected
            </span>
            <button
              onClick={handleAccept}
              disabled={selected.size === 0}
              className="px-3 py-1.5 text-xs font-medium text-white bg-accent hover:bg-accent/90 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Apply Remappings
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
