import { useEffect, useRef } from 'react';
import type { SchemaSuggestion } from '../lib/suggestions';
import { Button } from './ui/button';

interface SuggestionPanelProps {
  suggestions: SchemaSuggestion[];
  onScan: () => void;
  onAccept: (suggestion: SchemaSuggestion) => void;
  onAcceptAll: () => void;
  onDismiss: (suggestionId: string) => void;
  onFocus: (suggestion: SchemaSuggestion) => void;
  activeSuggestionId?: string | null;
  width: number;
  onWidthChange: (width: number) => void;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}

function scoreLabel(score: number): string {
  return `${Math.round(score * 100)}%`;
}

export function SuggestionPanel({
  suggestions,
  onScan,
  onAccept,
  onAcceptAll,
  onDismiss,
  onFocus,
  activeSuggestionId,
  width,
  onWidthChange,
  collapsed,
  onCollapsedChange,
}: SuggestionPanelProps) {
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  useEffect(() => {
    if (activeSuggestionId) {
      const el = cardRefs.current.get(activeSuggestionId);
      el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [activeSuggestionId]);

  return (
    <div className="flex shrink-0">
      {!collapsed && (
        <div
          className="w-px shrink-0 cursor-col-resize bg-border hover:bg-accent/60 transition-colors"
          onMouseDown={(e) => {
            e.preventDefault();
            const startX = e.clientX;
            const startW = width;
            const onMouseMove = (ev: MouseEvent) => {
              onWidthChange(Math.max(200, Math.min(600, startW - (ev.clientX - startX))));
            };
            const onMouseUp = () => {
              document.removeEventListener('mousemove', onMouseMove);
              document.removeEventListener('mouseup', onMouseUp);
            };
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
          }}
        />
      )}
      <div
        className="bg-surface flex flex-col overflow-hidden"
        style={{ width: collapsed ? 40 : width }}
      >
      <div className={`flex items-center ${collapsed ? 'justify-center' : 'justify-between px-3'} py-2 border-b border-border shrink-0`}>
        {!collapsed && <span className="text-xs font-semibold text-text">Suggestions</span>}
        <Button
          onClick={() => onCollapsedChange(!collapsed)}
          variant="ghost"
          size="icon-sm"
          className="text-text-secondary hover:text-text"
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
        </Button>
      </div>

      {!collapsed && (
        <>
          <div className="px-3 py-2 border-b border-border flex items-center gap-2 shrink-0">
            <Button
              onClick={onScan}
              variant="outline"
              size="sm"
              className="bg-elevated text-xs"
            >
              Scan File
            </Button>
            <Button
              onClick={onAcceptAll}
              disabled={suggestions.length === 0}
              size="sm"
              className="text-xs"
            >
              Accept All
            </Button>
            <span className="text-xs text-text-muted ml-auto">{suggestions.length} queued</span>
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-2">
            {suggestions.length === 0 ? (
              <div className="min-h-24 flex items-center justify-center rounded-lg border border-border bg-bg/40 px-3 text-center">
                <p className="text-xs text-text-muted">
                  Scan the loaded workbook to rank likely fields, tables, and discriminator cells.
                </p>
              </div>
            ) : (
              suggestions.map((suggestion) => (
                <div
                  key={suggestion.id}
                  ref={(el) => { if (el) cardRefs.current.set(suggestion.id, el); else cardRefs.current.delete(suggestion.id); }}
                  className={`rounded-lg border p-3 cursor-pointer transition-colors overflow-hidden ${
                    activeSuggestionId === suggestion.id
                      ? 'border-orange-500/60 bg-orange-500/10'
                      : 'border-border bg-bg/70 hover:bg-surface'
                  }`}
                  onClick={() => onFocus(suggestion)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-xs uppercase tracking-wide text-text-muted">
                        {suggestion.kind}
                      </div>
                      <div className="text-sm font-medium text-text truncate">
                        {describeSuggestionTitle(suggestion)}
                      </div>
                      <div className="mt-1 text-[11px] font-mono text-orange-700 dark:text-orange-300/90 break-all">
                        {describeSuggestionRange(suggestion)}
                      </div>
                      <div className="text-xs text-text-muted mt-1">
                        {suggestion.sheetName} · {scoreLabel(suggestion.score)}
                      </div>
                    </div>
                    <Button
                      onClick={(event) => {
                        event.stopPropagation();
                        onAccept(suggestion);
                      }}
                      size="sm"
                      className="shrink-0 bg-emerald-600/90 px-2 text-xs text-white hover:bg-emerald-700"
                    >
                      Accept
                    </Button>
                  </div>

                  <div className="mt-2 text-xs text-text-secondary space-y-1">
                    {suggestion.reasons.slice(0, 3).map((reason) => (
                      <div key={reason}>• {reason}</div>
                    ))}
                  </div>
                  <div className="mt-3 flex justify-end">
                    <Button
                      onClick={(event) => {
                        event.stopPropagation();
                        onDismiss(suggestion.id);
                      }}
                      variant="ghost"
                      size="xs"
                      className="text-xs text-text-muted hover:text-text-secondary"
                    >
                      Dismiss
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        </>
      )}
      </div>
    </div>
  );
}

function describeSuggestionTitle(suggestion: SchemaSuggestion): string {
  if (suggestion.kind === 'field') {
    return suggestion.field.name;
  }
  if (suggestion.kind === 'table') {
    return suggestion.field.name;
  }
  if (suggestion.kind === 'remap') {
    return suggestion.fieldName;
  }
  return suggestion.discriminatorValue;
}

function describeSuggestionRange(suggestion: SchemaSuggestion): string {
  if (suggestion.kind === 'discriminator') {
    return suggestion.cellRef;
  }
  if (suggestion.kind === 'remap') {
    return `${suggestion.oldRef} → ${suggestion.newRef}`;
  }
  return suggestion.targetRef;
}
