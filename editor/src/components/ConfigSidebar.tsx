import { useMemo } from 'react';
import { FieldPanel } from './FieldPanel';
import { MissingFieldsPanel } from './MissingFieldsPanel';
import { ProblemsPanel } from './ProblemsPanel';
import { SuggestionPanel } from './SuggestionPanel';
import { ValidationPanel } from './ValidationPanel';
import { VersionDiffPanel } from './VersionDiffPanel';
import { YamlPreview } from './YamlPreview';
import { findSchemaProblems } from '../lib/problems';
import type { SchemaSuggestion } from '../lib/suggestions';
import type { StencilField, StencilVersion } from '../lib/types';
import type { useSchema } from '../hooks/useSchema';
import type { useSpreadsheet } from '../hooks/useSpreadsheet';

export type ConfigTab = 'fields' | 'suggest' | 'problems' | 'versions' | 'yaml';

const TABS: { id: ConfigTab; label: string }[] = [
  { id: 'fields', label: 'Fields' },
  { id: 'suggest', label: 'Suggest' },
  { id: 'problems', label: 'Problems' },
  { id: 'versions', label: 'Versions' },
  { id: 'yaml', label: 'YAML' },
];

interface ConfigSidebarProps {
  activeTab: ConfigTab;
  onTabChange: (tab: ConfigTab) => void;
  schema: ReturnType<typeof useSchema>;
  spreadsheet: ReturnType<typeof useSpreadsheet>;
  activeVersion?: StencilVersion;
  suggestions: SchemaSuggestion[];
  activeSuggestionId: string | null;
  onScan: () => void;
  onAcceptSuggestion: (suggestion: SchemaSuggestion) => void;
  onAcceptAllSuggestions: () => void;
  onDismissSuggestion: (suggestionId: string) => void;
  onFocusSuggestion: (suggestion: SchemaSuggestion) => void;
  onHighlightField: (field: StencilField) => void;
  onEditField: (field: StencilField) => void;
  onDuplicateField: (field: StencilField) => void;
}

export function ConfigSidebar({
  activeTab,
  onTabChange,
  schema,
  spreadsheet,
  activeVersion,
  suggestions,
  activeSuggestionId,
  onScan,
  onAcceptSuggestion,
  onAcceptAllSuggestions,
  onDismissSuggestion,
  onFocusSuggestion,
  onHighlightField,
  onEditField,
  onDuplicateField,
}: ConfigSidebarProps) {
  const versions = schema.schema.versions;
  const activeVersionIndex = schema.activeVersionIndex;
  const defaultSheet = spreadsheet.sheetNames[0] ?? 'Sheet1';
  const workbook = spreadsheet.workbook;
  const fields = useMemo(() => activeVersion?.fields ?? [], [activeVersion]);

  const problemCount = useMemo(
    () => findSchemaProblems(fields, versions, activeVersion?.discriminatorValue, defaultSheet).length,
    [fields, versions, activeVersion?.discriminatorValue, defaultSheet],
  );

  // Only the tabs whose count is not visible elsewhere carry a badge.
  const badgeFor = (tab: ConfigTab): number | null => {
    switch (tab) {
      case 'suggest':
        return suggestions.length || null;
      case 'problems':
        return problemCount || null;
      default:
        return null;
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        role="tablist"
        aria-label="Configuration sections"
        className="m-2 flex shrink-0 items-center gap-0.5 overflow-x-auto rounded-lg border border-border bg-bg/60 p-0.5"
      >
        {TABS.map((tab) => {
          const isActive = tab.id === activeTab;
          const badge = badgeFor(tab.id);
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => onTabChange(tab.id)}
              className={`inline-flex shrink-0 items-center gap-1 rounded-[7px] px-1.5 py-1 text-xs transition-colors ${
                isActive
                  ? 'bg-elevated font-medium text-text shadow-sm'
                  : 'text-text-secondary hover:text-text'
              }`}
            >
              {tab.label}
              {badge != null && (
                <span
                  className={`rounded-full px-1.5 py-px text-[10px] ring-1 ${
                    tab.id === 'problems'
                      ? 'bg-amber-500/20 text-amber-700 ring-amber-500/40 dark:text-amber-200'
                      : 'bg-elevated text-text-secondary ring-border'
                  }`}
                >
                  {badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {activeTab === 'fields' && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div>
            <FieldPanel
              fields={fields}
              validation={activeVersion?.validation ?? {}}
              defaultSheet={defaultSheet}
              onRemoveField={schema.removeField}
              onHighlightField={onHighlightField}
              onEditField={onEditField}
              onDuplicateField={onDuplicateField}
              onMoveField={schema.moveField}
            />
          </div>
          <div className="pt-1">
            <MissingFieldsPanel
              activeFields={fields}
              versions={versions}
              activeVersionDiscriminatorValue={activeVersion?.discriminatorValue}
              defaultSheet={defaultSheet}
            />
            {activeVersion && (
              <ValidationPanel
                fields={activeVersion.fields}
                validation={activeVersion.validation}
                workbook={workbook}
                defaultSheet={defaultSheet}
                onSetValidation={schema.setValidation}
                onRemoveValidation={schema.removeValidation}
              />
            )}
          </div>
        </div>
      )}

      {activeTab === 'suggest' && (
        <SuggestionPanel
          suggestions={suggestions}
          onScan={onScan}
          onAccept={onAcceptSuggestion}
          onAcceptAll={onAcceptAllSuggestions}
          onDismiss={onDismissSuggestion}
          onFocus={onFocusSuggestion}
          activeSuggestionId={activeSuggestionId}
        />
      )}

      {activeTab === 'problems' && (
        <ProblemsPanel
          embedded
          activeFields={fields}
          versions={versions}
          activeVersionDiscriminatorValue={activeVersion?.discriminatorValue}
          defaultSheet={defaultSheet}
          onHighlightField={onHighlightField}
        />
      )}

      {activeTab === 'versions' && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 space-y-1 border-b border-border px-3 py-2">
            {versions.map((version, index) => {
              const isActive = index === activeVersionIndex;
              return (
                <div
                  key={version.id ?? index}
                  className={`flex items-center gap-2 rounded-md border px-2 py-1.5 ${
                    isActive ? 'border-border-strong bg-elevated' : 'border-border bg-bg/40'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => schema.setActiveVersionIndex(index)}
                    title={isActive ? 'Selected version' : 'Switch to this version'}
                    className={`min-w-0 flex-1 truncate text-left font-mono text-xs ${
                      isActive ? 'text-text' : 'text-text-secondary hover:text-text'
                    }`}
                  >
                    {version.discriminatorValue || 'untitled'}
                  </button>
                  <span className="shrink-0 text-[11px] text-text-muted">
                    {version.fields.length} field{version.fields.length === 1 ? '' : 's'}
                  </span>
                  {isActive && (
                    <span className="shrink-0 rounded bg-surface px-1.5 py-px text-[10px] text-text-muted">
                      selected
                    </span>
                  )}
                </div>
              );
            })}
            <p className="pt-1 text-[11px] text-text-muted">
              Switch with the chips in the workbook toolbar; duplicate or remove a version
              there too.
            </p>
          </div>
          <VersionDiffPanel embedded versions={versions} activeVersionIndex={activeVersionIndex} />
        </div>
      )}

      {activeTab === 'yaml' && (
        <YamlPreview
          embedded
          schema={schema.schema}
          expanded
          onToggleExpanded={() => { /* always expanded inside the tab */ }}
        />
      )}
    </div>
  );
}
