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
}: SuggestionPanelProps) {
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  useEffect(() => {
    if (activeSuggestionId) {
      const el = cardRefs.current.get(activeSuggestionId);
      el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [activeSuggestionId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
        suggestionGroups(suggestions).map((group) => (
          <div key={group.sheetName} className="space-y-2">
            {group.showHeader && (
              <div className="px-1 pt-1 text-[11px] uppercase tracking-wide text-text-muted">
                {group.sheetName}
              </div>
            )}
            {group.items.map((suggestion) => (
          <div
            key={suggestion.id}
            ref={(el) => { if (el) cardRefs.current.set(suggestion.id, el); else cardRefs.current.delete(suggestion.id); }}
            className={`rounded-lg border p-3 cursor-pointer transition-colors overflow-hidden ${
              activeSuggestionId === suggestion.id
                ? 'border-suggestion bg-suggestion-soft'
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
                <div className="mt-1 text-[11px] font-mono text-suggestion-ink break-all">
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
                className="shrink-0 px-2 text-xs"
              >
                Accept
              </Button>
            </div>

            {suggestion.kind === 'table' && (
              <div className="mt-1 text-[11px] font-mono text-text-muted break-all">
                {suggestion.field.tableOrientation === 'vertical' ? 'rows' : 'columns'}: {describeSuggestionColumns(suggestion.field.columns)}
              </div>
            )}

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
            ))}
          </div>
        ))
      )}
      </div>
    </div>
  );
}

interface SuggestionGroup {
  sheetName: string;
  showHeader: boolean;
  items: SchemaSuggestion[];
}

function suggestionGroups(suggestions: SchemaSuggestion[]): SuggestionGroup[] {
  const sheetNames = new Set(suggestions.map((suggestion) => suggestion.sheetName));
  const groups: SuggestionGroup[] = [];

  for (const suggestion of suggestions) {
    const current = groups[groups.length - 1];
    if (current && current.sheetName === suggestion.sheetName) {
      current.items.push(suggestion);
      continue;
    }
    groups.push({
      sheetName: suggestion.sheetName,
      showHeader: sheetNames.size > 1,
      items: [suggestion],
    });
  }

  return groups;
}

function describeSuggestionColumns(columns: Record<string, string> | undefined): string {
  const entries = Object.entries(columns ?? {});
  if (entries.length === 0) return 'none detected';
  const shown = entries.slice(0, 8).map(([key, name]) => `${key}: ${name}`);
  const hidden = entries.length - shown.length;
  return hidden > 0 ? `${shown.join(' · ')} · +${hidden} more` : shown.join(' · ');
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
