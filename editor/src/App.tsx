import { useState, useCallback, useEffect } from 'react';
import { FileUpload } from './components/FileUpload';
import { SpreadsheetView } from './components/SpreadsheetView';
import { FieldPanel } from './components/FieldPanel';
import { FieldDialog } from './components/FieldDialog';
import { DiscriminatorPicker } from './components/DiscriminatorPicker';
import { VersionManager } from './components/VersionManager';
import { ValidationPanel } from './components/ValidationPanel';
import { YamlPreview } from './components/YamlPreview';
import { ExportButton } from './components/ExportButton';
import { ImportButton } from './components/ImportButton';
import { BatchExtractTab } from './components/BatchExtractTab';
import { SuggestionPanel } from './components/SuggestionPanel';
import { FieldNameDialog } from './components/FieldNameDialog';
import { useSpreadsheet } from './hooks/useSpreadsheet';
import { useSchema } from './hooks/useSchema';
import { formatAddress, formatRange, normalizeRange } from './lib/addressing';
import type { StencilField, StencilSchema, CellAddress } from './lib/types';
import { parseAddress, letterToColIndex } from './lib/addressing';
import { invoke } from '@tauri-apps/api/core';
import { scanWorkbookForSuggestions, type SchemaSuggestion } from './lib/suggestions';
import { getSheetData, type CellValue, type Workbook } from './lib/excel';

type Mode = 'select' | 'discriminator';
type AppTab = 'editor' | 'extract';

interface DialogSelectionState {
  sheetName: string;
  selection: {
    start: CellAddress;
    end: CellAddress;
  };
}

interface SuggestionPreviewState extends DialogSelectionState {
  suggestionId: string;
}

function isLikelyTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function splitSheetRef(ref: string): { sheet?: string; value: string } {
  const idx = ref.indexOf('!');
  if (idx < 0) return { value: ref };
  return {
    sheet: ref.slice(0, idx),
    value: ref.slice(idx + 1),
  };
}

function resolveOpenEndedEndRow(
  workbook: Workbook | null,
  sheetName: string,
  start: CellAddress,
  endCol: number,
): number {
  if (!workbook) return start.row;

  try {
    const sheetData = getSheetData(workbook, sheetName);
    let endRow = start.row;

    for (let row = start.row; row < sheetData.rows; row++) {
      let allEmpty = true;
      for (let col = start.col; col <= endCol; col++) {
        const value = sheetData.cells[row]?.[col]?.value ?? null;
        if (value !== null && value !== '') {
          allEmpty = false;
          break;
        }
      }
      if (allEmpty) break;
      endRow = row;
    }

    return endRow;
  } catch {
    return start.row;
  }
}

function getFieldSelection(
  field: StencilField,
  workbook: Workbook | null,
  defaultSheet: string,
): { sheet?: string; start: CellAddress; end: CellAddress } | null {
  const rawRef = field.cell ?? field.range;
  if (!rawRef) return null;

  const split = splitSheetRef(rawRef);
  const [startRef, endRef] = split.value.split(':');
  if (!startRef) return null;

  const start = parseAddress(startRef.toUpperCase());
  let end = start;

  if (endRef) {
    const openEndedMatch = endRef.toUpperCase().match(/^([A-Z]+)$/);
    if (openEndedMatch?.[1]) {
      const endCol = letterToColIndex(openEndedMatch[1]);
      const sheetName = split.sheet ?? defaultSheet;
      end = {
        col: endCol,
        row: resolveOpenEndedEndRow(workbook, sheetName, start, endCol),
      };
    } else {
      end = parseAddress(endRef.toUpperCase());
    }
  }

  return { sheet: split.sheet, start, end };
}

function headerCellScore(value: CellValue | undefined): number {
  if (typeof value !== 'string') return 0;
  const trimmed = value.trim();
  if (!trimmed) return 0;
  if (trimmed.length > 64) return -1;
  if (/[<>=%]/.test(trimmed)) return -2;
  if (/^\d+([./-]\d+)*$/.test(trimmed)) return -2;
  if (/^(true|false|yes|no|ok|nq|nd)$/i.test(trimmed)) return -2;
  if (/^[A-Z0-9._-]{7,}$/i.test(trimmed) && !/\s/.test(trimmed)) return -2;
  if (/[a-z]/i.test(trimmed)) return 2;
  return 0;
}

function maybePromoteSuggestedTableHeader(
  field: StencilField,
  workbook: Workbook | null,
  defaultSheet: string,
): StencilField {
  if (!workbook || field.type !== 'table' || !field.range) return field;

  const selection = getFieldSelection(field, workbook, defaultSheet);
  if (!selection) return field;
  if (selection.start.row === 0) return field;

  const sheetName = selection.sheet ?? defaultSheet;
  const sheetData = getSheetData(workbook, sheetName);
  const startCol = Math.min(selection.start.col, selection.end.col);
  const endCol = Math.max(selection.start.col, selection.end.col);
  const currentHeaderRow = selection.start.row;
  const candidateHeaderRow = currentHeaderRow - 1;

  let currentScore = 0;
  let candidateScore = 0;
  for (let col = startCol; col <= endCol; col++) {
    currentScore += headerCellScore(sheetData.data[currentHeaderRow]?.[col]);
    candidateScore += headerCellScore(sheetData.data[candidateHeaderRow]?.[col]);
  }

  if (candidateScore <= currentScore) return field;

  const nextStart = { row: candidateHeaderRow, col: startCol };
  const nextEnd = { row: selection.end.row, col: endCol };
  const nextRef = `${sheetName !== defaultSheet ? `${sheetName}!` : ''}${formatRange(nextStart, nextEnd, true)}`;
  return {
    ...field,
    range: nextRef,
    columns: undefined,
  };
}

export default function App() {
  const spreadsheet = useSpreadsheet();
  const schema = useSchema();
  const [mode, setMode] = useState<Mode>('select');
  const [showFieldDialog, setShowFieldDialog] = useState(false);
  const [editingField, setEditingField] = useState<StencilField | null>(null);
  const [editingExistingFieldName, setEditingExistingFieldName] = useState<string | null>(null);
  const [dialogSelection, setDialogSelection] = useState<DialogSelectionState | null>(null);
  const [fieldDialogTitle, setFieldDialogTitle] = useState<string | null>(null);
  const [resizeFieldName, setResizeFieldName] = useState<string | null>(null);
  const [moveFieldName, setMoveFieldName] = useState<string | null>(null);
  const [resizeSuggestionId, setResizeSuggestionId] = useState<string | null>(null);
  const [suggestionPreview, setSuggestionPreview] = useState<SuggestionPreviewState | null>(null);
  const [activeTab, setActiveTab] = useState<AppTab>('editor');
  const [rightSidebarCollapsed, setRightSidebarCollapsed] = useState(false);
  const [suggestions, setSuggestions] = useState<SchemaSuggestion[]>([]);
  const [activeSuggestionId, setActiveSuggestionId] = useState<string | null>(null);
  const [pendingSuggestionId, setPendingSuggestionId] = useState<string | null>(null);
  const [renamingField, setRenamingField] = useState<StencilField | null>(null);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    if (typeof window !== 'undefined') {
      return (localStorage.getItem('stencil-theme') as 'dark' | 'light') ?? 'dark';
    }
    return 'dark';
  });

  useEffect(() => {
    document.documentElement.classList.toggle('light', theme === 'light');
    localStorage.setItem('stencil-theme', theme);
  }, [theme]);

  const handleFileLoaded = useCallback(
    (buffer: ArrayBuffer) => {
      spreadsheet.loadFile(buffer);
      setSuggestions([]);
      setActiveSuggestionId(null);
      setSuggestionPreview(null);
      setDialogSelection(null);
    },
    [spreadsheet],
  );

  const handleSelectionEnd = useCallback(() => {
    const sel = spreadsheet.selection;
    spreadsheet.endSelection();

    if (!sel) return;

    if (mode === 'discriminator') {
      const ref = formatAddress(sel.start);
      const sheetRef =
        spreadsheet.activeSheet !== spreadsheet.sheetNames[0]
          ? `${spreadsheet.activeSheet}!${ref}`
          : ref;
      schema.setDiscriminator(sheetRef);

      // Auto-set current version's discriminator value from the cell
      const cellValue = spreadsheet.sheetData?.data[sel.start.row]?.[sel.start.col];
      if (cellValue != null) {
        schema.setVersionDiscriminatorValue(String(cellValue).trim());
      }

      setMode('select');
      spreadsheet.clearSelection();
    } else {
      const activeVersion = schema.activeVersion;

      if (activeVersion && moveFieldName) {
        const existing = activeVersion.fields.find((field) => field.name === moveFieldName);
        if (existing) {
          const normalized = normalizeRange(sel.start, sel.end);
          const isRange = normalized.start.col !== normalized.end.col || normalized.start.row !== normalized.end.row;
          const defaultSheet = spreadsheet.sheetNames[0] ?? '';
          const sheetPrefix = spreadsheet.activeSheet !== defaultSheet
            ? `${spreadsheet.activeSheet}!`
            : '';

          if (existing.cell && !isRange) {
            schema.updateField(existing.name, {
              cell: `${sheetPrefix}${formatAddress(normalized.start)}`,
            });
          } else if (existing.range) {
            schema.updateField(existing.name, {
              range: `${sheetPrefix}${formatRange(normalized.start, normalized.end, existing.openEnded)}`,
              columns: existing.type === 'table' ? undefined : existing.columns,
            });
          } else if (isRange) {
            schema.updateField(existing.name, {
              cell: undefined,
              range: `${sheetPrefix}${formatRange(normalized.start, normalized.end)}`,
            });
          } else {
            schema.updateField(existing.name, {
              cell: `${sheetPrefix}${formatAddress(normalized.start)}`,
            });
          }
        }
        setMoveFieldName(null);
        spreadsheet.clearSelection();
        return;
      }

      if (activeVersion && resizeFieldName) {
        const existing = activeVersion.fields.find((field) => field.name === resizeFieldName);
        if (existing) {
          setEditingField(existing);
          setEditingExistingFieldName(existing.name);
          setFieldDialogTitle('Edit Field');
          setResizeFieldName(null);
          setShowFieldDialog(true);
          return;
        }
      }

      if (resizeSuggestionId) {
        setSuggestionPreview({
          suggestionId: resizeSuggestionId,
          sheetName: spreadsheet.activeSheet,
          selection: {
            start: sel.start,
            end: sel.end,
          },
        });
        setResizeSuggestionId(null);
        setDialogSelection({
          sheetName: spreadsheet.activeSheet,
          selection: {
            start: sel.start,
            end: sel.end,
          },
        });
        return;
      }

      setResizeFieldName(null);
      setEditingField(null);
      setEditingExistingFieldName(null);
      setFieldDialogTitle(null);
      setDialogSelection({
        sheetName: spreadsheet.activeSheet,
        selection: {
          start: sel.start,
          end: sel.end,
        },
      });
      setShowFieldDialog(true);
    }
  }, [moveFieldName, resizeFieldName, resizeSuggestionId, spreadsheet, mode, schema]);

  const handleSaveField = useCallback(
    (field: StencilField) => {
      if (editingExistingFieldName) {
        if (field.name === editingExistingFieldName) {
          schema.updateField(editingExistingFieldName, field);
        } else {
          const validation = schema.activeVersion?.validation[editingExistingFieldName];
          schema.addField(field);
          if (validation) {
            schema.setValidation(field.name, validation);
          }
          schema.removeField(editingExistingFieldName);
        }
      } else {
        schema.addField(field);
      }
      setResizeFieldName(null);
      setMoveFieldName(null);
      setResizeSuggestionId(null);
      setEditingField(null);
      setEditingExistingFieldName(null);
      if (pendingSuggestionId) {
        setSuggestions((current) => current.filter((entry) => entry.id !== pendingSuggestionId));
        setActiveSuggestionId((current) => current === pendingSuggestionId ? null : current);
        setSuggestionPreview((current) => current?.suggestionId === pendingSuggestionId ? null : current);
      }
      setPendingSuggestionId(null);
      setDialogSelection(null);
      setFieldDialogTitle(null);
      setShowFieldDialog(false);
      spreadsheet.clearSelection();
    },
    [editingExistingFieldName, pendingSuggestionId, schema, spreadsheet],
  );

  const handleCancelDialog = useCallback(() => {
    setResizeFieldName(null);
    setMoveFieldName(null);
    setResizeSuggestionId(null);
    setSuggestionPreview(null);
    setEditingField(null);
    setEditingExistingFieldName(null);
    setPendingSuggestionId(null);
    setDialogSelection(null);
    setFieldDialogTitle(null);
    setShowFieldDialog(false);
    spreadsheet.clearSelection();
  }, [spreadsheet]);

  const handleHighlightField = useCallback(
    (field: StencilField) => {
      const selection = getFieldSelection(field, spreadsheet.workbook, spreadsheet.sheetNames[0] ?? '');
      if (!selection) return;

      if (selection.sheet && selection.sheet !== spreadsheet.activeSheet) {
        spreadsheet.switchSheet(selection.sheet);
      }

      spreadsheet.startSelection(selection.start);
      spreadsheet.extendSelection(selection.end);
      spreadsheet.endSelection();
    },
    [spreadsheet],
  );

  const renameField = useCallback((field: StencilField, nextName: string) => {
    const trimmed = nextName.trim();
    if (!trimmed || trimmed === field.name) return;

    const validation = schema.activeVersion?.validation[field.name];
    schema.addField({ ...field, name: trimmed });
    if (validation) {
      schema.setValidation(trimmed, validation);
    }
    schema.removeField(field.name);
  }, [schema]);

  const handleImport = useCallback(
    (imported: StencilSchema) => {
      schema.loadSchema(imported);
    },
    [schema],
  );

  const handleNew = useCallback(() => {
    spreadsheet.reset();
    schema.resetSchema();
    setSuggestions([]);
  }, [spreadsheet, schema]);

  const handleToggleDiscriminator = useCallback(() => {
    setMode((m) => (m === 'discriminator' ? 'select' : 'discriminator'));
  }, []);

  const handleStartSelection = useCallback(
    (addr: CellAddress) => {
      spreadsheet.startSelection(addr);
    },
    [spreadsheet],
  );

  const handleExtendSelection = useCallback(
    (addr: CellAddress) => {
      spreadsheet.extendSelection(addr);
    },
    [spreadsheet],
  );

  const handleSetSelection = useCallback(
    (start: CellAddress, end: CellAddress) => {
      spreadsheet.setSelection(start, end);
    },
    [spreadsheet],
  );

  const handleStartResizeField = useCallback((fieldName: string) => {
    setResizeFieldName(fieldName);
  }, []);

  const handleStartMoveField = useCallback((fieldName: string) => {
    setMoveFieldName(fieldName);
  }, []);

  const handleStartResizeSuggestion = useCallback((suggestionId: string) => {
    setResizeFieldName(null);
    setResizeSuggestionId(suggestionId);
  }, []);

  const handleOpenFileInEditor = useCallback(
    async ({ sourcePath, file }: { sourcePath: string; file?: File }) => {
      if (file) {
        const buffer = await file.arrayBuffer();
        spreadsheet.loadFile(buffer);
        setActiveTab('editor');
        setSuggestions([]);
        setActiveSuggestionId(null);
        setDialogSelection(null);
        return;
      }

      if (!isLikelyTauriRuntime()) {
        return;
      }

      const bytes = await invoke<number[]>('read_file_bytes', { filePath: sourcePath });
      const buffer = new Uint8Array(bytes).buffer;
      spreadsheet.loadFile(buffer);
      setActiveTab('editor');
      setSuggestions([]);
      setActiveSuggestionId(null);
      setSuggestionPreview(null);
      setDialogSelection(null);
    },
    [spreadsheet],
  );

  const handleScanSuggestions = useCallback(() => {
    if (!spreadsheet.workbook) return;
    const nextSuggestions = scanWorkbookForSuggestions(spreadsheet.workbook, {
      existingFields: schema.activeVersion?.fields ?? [],
      existingDiscriminatorCells: schema.schema.discriminator.cells ?? [],
    });
    setSuggestions(nextSuggestions);
    setActiveSuggestionId(nextSuggestions[0]?.id ?? null);
    setSuggestionPreview(null);
  }, [schema.activeVersion?.fields, schema.schema.discriminator.cells, spreadsheet.workbook]);

  const applySuggestion = useCallback((suggestion: SchemaSuggestion) => {
    if (suggestion.kind === 'discriminator') {
      schema.setDiscriminator(suggestion.cellRef);
      schema.setVersionDiscriminatorValue(suggestion.discriminatorValue);
      setSuggestions((current) => current.filter((entry) => entry.id !== suggestion.id));
      setActiveSuggestionId((current) => current === suggestion.id ? null : current);
      setSuggestionPreview((current) => current?.suggestionId === suggestion.id ? null : current);
      return;
    }

    const preparedField = maybePromoteSuggestedTableHeader(
      suggestion.field,
      spreadsheet.workbook,
      spreadsheet.sheetNames[0] ?? '',
    );
    const suggestedSelection = getFieldSelection(
      preparedField,
      spreadsheet.workbook,
      spreadsheet.sheetNames[0] ?? '',
    );
    if (!suggestedSelection) return;

    const previewSelection =
      suggestionPreview?.suggestionId === suggestion.id
      && suggestionPreview.sheetName === (suggestedSelection.sheet ?? (spreadsheet.sheetNames[0] ?? ''))
        ? suggestionPreview.selection
        : null;
    const shouldUseAdjustedSelection = Boolean(previewSelection);
    const selection = shouldUseAdjustedSelection
      ? {
          sheet: suggestionPreview?.sheetName,
          start: previewSelection!.start,
          end: previewSelection!.end,
        }
      : suggestedSelection;
    if (!selection) return;

    if (selection.sheet && selection.sheet !== spreadsheet.activeSheet) {
      spreadsheet.switchSheet(selection.sheet);
    }

    spreadsheet.startSelection(selection.start);
    spreadsheet.extendSelection(selection.end);
    spreadsheet.endSelection();
    setDialogSelection({
      sheetName: selection.sheet ?? (spreadsheet.sheetNames[0] ?? ''),
      selection: {
        start: selection.start,
        end: selection.end,
      },
    });
    setEditingField(
      shouldUseAdjustedSelection && preparedField.type === 'table'
        ? { ...preparedField, columns: undefined }
        : preparedField,
    );
    setEditingExistingFieldName(null);
    setPendingSuggestionId(suggestion.id);
    setFieldDialogTitle('Accept Suggestion');
    setShowFieldDialog(true);
  }, [schema, spreadsheet, suggestionPreview]);

  const handleAcceptAllSuggestions = useCallback(() => {
    for (const suggestion of suggestions) {
      if (suggestion.kind === 'discriminator') {
        schema.setDiscriminator(suggestion.cellRef);
        schema.setVersionDiscriminatorValue(suggestion.discriminatorValue);
        continue;
      }

      const existing = schema.activeVersion?.fields.find((field) => field.name === suggestion.field.name);
      if (existing) {
        schema.updateField(existing.name, suggestion.field);
      } else {
        schema.addField(suggestion.field);
      }
    }

    setSuggestions([]);
    setActiveSuggestionId(null);
    setSuggestionPreview(null);
  }, [schema, suggestions]);

  const handleDismissSuggestion = useCallback((suggestionId: string) => {
    setSuggestions((current) => current.filter((entry) => entry.id !== suggestionId));
    setActiveSuggestionId((current) => current === suggestionId ? null : current);
    setSuggestionPreview((current) => current?.suggestionId === suggestionId ? null : current);
  }, []);

  const handleFocusSuggestion = useCallback((suggestion: SchemaSuggestion) => {
    const rawRef = suggestion.kind === 'discriminator'
      ? suggestion.cellRef
      : (suggestion.field.cell ?? suggestion.field.range);
    if (!rawRef) return;

    const selection = getFieldSelection({
      name: suggestion.kind === 'discriminator' ? suggestion.id : suggestion.field.name,
      cell: suggestion.kind === 'discriminator' ? suggestion.cellRef : suggestion.field.cell,
      range: suggestion.kind === 'discriminator' ? undefined : suggestion.field.range,
    }, spreadsheet.workbook, spreadsheet.sheetNames[0] ?? '');
    if (!selection) return;

    if (selection.sheet && selection.sheet !== spreadsheet.activeSheet) {
      spreadsheet.switchSheet(selection.sheet);
    }

    spreadsheet.startSelection(selection.start);
    spreadsheet.extendSelection(selection.end);
    spreadsheet.endSelection();
    setActiveSuggestionId(suggestion.id);
    setSuggestionPreview((current) => current?.suggestionId === suggestion.id ? current : null);
    setActiveTab('editor');
  }, [spreadsheet]);

  const handleRenameField = useCallback((field: StencilField) => {
    setRenamingField(field);
  }, []);

  const handleConfirmRenameField = useCallback((nextName: string) => {
    if (!renamingField) return;
    renameField(renamingField, nextName);
    setRenamingField(null);
  }, [renameField, renamingField]);

  const handleCancelNameDialog = useCallback(() => {
    setRenamingField(null);
  }, []);

  if ((!spreadsheet.workbook || !spreadsheet.sheetData) && activeTab === 'editor') {
    return (
      <div className="min-h-screen bg-bg flex flex-col">
        <header className="px-6 py-4 border-b border-cell-border">
          <h1 className="text-xl font-bold text-text tracking-tight">
            Stencil Editor
          </h1>
          <p className="text-xs text-text-muted mt-0.5">
            Define Excel extraction schemas visually
          </p>
          <div className="mt-3 inline-flex rounded-lg border border-border bg-surface/60 p-1">
            <button
              onClick={() => setActiveTab('editor')}
              className="px-3 py-1.5 rounded text-xs font-medium bg-elevated text-text"
            >
              Schema Editor
            </button>
            <button
              onClick={() => setActiveTab('extract')}
              className="px-3 py-1.5 rounded text-xs font-medium text-text-secondary hover:text-text hover:bg-elevated/60"
            >
              Batch Extract
            </button>
          </div>
        </header>
        <FileUpload onFileLoaded={handleFileLoaded} />
      </div>
    );
  }

  const activeVersion = schema.activeVersion;

  return (
    <div className="h-screen flex flex-col bg-bg">
      {/* Top bar */}
      <header className="flex items-center justify-between px-4 py-2 border-b border-cell-border bg-bg shrink-0">
        <div className="flex items-center gap-4">
          <h1 className="text-sm font-bold text-text tracking-tight">
            Stencil Editor
          </h1>

          <div className="inline-flex rounded-lg border border-border bg-surface/60 p-1">
            <button
              onClick={() => setActiveTab('editor')}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                activeTab === 'editor'
                  ? 'bg-elevated text-text'
                  : 'text-text-secondary hover:text-text hover:bg-elevated/60'
              }`}
            >
              Schema Editor
            </button>
            <button
              onClick={() => setActiveTab('extract')}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                activeTab === 'extract'
                  ? 'bg-elevated text-text'
                  : 'text-text-secondary hover:text-text hover:bg-elevated/60'
              }`}
            >
              Batch Extract
            </button>
          </div>

          <button
            onClick={handleNew}
            className="px-2 py-1 text-xs text-text-secondary hover:text-text bg-elevated border border-border hover:border-border-strong rounded transition-colors"
            title="New schema"
          >
            New
          </button>
          <div className="h-4 w-px bg-border" />
          <input
            type="text"
            value={schema.schema.name}
            onChange={(e) => schema.setName(e.target.value)}
            placeholder="schema_name"
            className="px-2 py-1 bg-input border border-border rounded text-sm text-text font-mono placeholder:text-text-faint focus:outline-none focus:border-accent w-40"
          />
          <input
            type="text"
            value={schema.schema.description}
            onChange={(e) => schema.setDescription(e.target.value)}
            placeholder="Description"
            className="px-2 py-1 bg-input border border-border rounded text-sm text-text-secondary placeholder:text-text-faint focus:outline-none focus:border-accent w-64"
          />
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            className="px-2 py-1 text-sm bg-elevated border border-border hover:border-border-strong rounded transition-colors"
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          >
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
          {activeTab === 'editor' && spreadsheet.workbook && (
            <button
              onClick={handleScanSuggestions}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-elevated text-text-secondary border border-border-strong hover:border-border-strong transition-colors"
              title="Scan workbook for suggested config"
            >
              Suggest
            </button>
          )}
          <ImportButton onImport={handleImport} />
          {activeTab === 'editor' && (
            <DiscriminatorPicker
              isActive={mode === 'discriminator'}
              currentCell={schema.schema.discriminator.cell}
              cells={schema.schema.discriminator.cells}
              onToggle={handleToggleDiscriminator}
              onRemoveCell={schema.removeDiscriminator}
              onClearAll={schema.clearDiscriminators}
            />
          )}
          <ExportButton schema={schema.schema} />
        </div>
      </header>

      {activeTab === 'editor' && (
        <>
          {/* Version bar */}
          <div className="flex items-center px-4 py-1.5 border-b border-cell-border bg-surface/50 shrink-0">
            <span className="text-xs text-text-muted mr-3">Versions:</span>
            <VersionManager
              versions={schema.schema.versions}
              activeIndex={schema.activeVersionIndex}
              onSwitchVersion={schema.setActiveVersionIndex}
              onAddVersion={schema.addVersion}
              onRemoveVersion={schema.removeVersion}
              onUpdateDiscriminatorValue={schema.setVersionDiscriminatorValue}
            />
          </div>

          {/* Main content */}
          {spreadsheet.workbook && spreadsheet.sheetData ? (
            <div className="flex-1 flex overflow-hidden">
              {/* Spreadsheet */}
              <div className="flex-1 overflow-hidden">
                <SpreadsheetView
                  sheetData={spreadsheet.sheetData}
                  sheetNames={spreadsheet.sheetNames}
                  activeSheet={spreadsheet.activeSheet}
                  selection={spreadsheet.selection}
                  fields={activeVersion?.fields ?? []}
                  discriminatorCells={schema.schema.discriminator.cells}
                  suggestions={suggestions}
                  activeSuggestionId={activeSuggestionId}
                  suggestionPreviewSelection={
                    suggestionPreview?.suggestionId === activeSuggestionId
                      ? suggestionPreview.selection
                      : null
                  }
                  onSwitchSheet={spreadsheet.switchSheet}
                  onStartSelection={handleStartSelection}
                  onExtendSelection={handleExtendSelection}
                  onSetSelection={handleSetSelection}
                  onStartResizeField={handleStartResizeField}
                  onStartMoveField={handleStartMoveField}
                  onStartResizeSuggestion={handleStartResizeSuggestion}
                  onEndSelection={handleSelectionEnd}
                />
              </div>

              {/* Right panel */}
              <div
                className={`flex flex-col shrink-0 overflow-hidden border-l border-border bg-surface transition-all ${
                  rightSidebarCollapsed ? 'w-10' : 'w-80'
                }`}
              >
                <div className="flex items-center justify-end px-2 py-2 border-b border-border shrink-0">
                  <button
                    onClick={() => setRightSidebarCollapsed(!rightSidebarCollapsed)}
                    className="text-text-secondary hover:text-text p-1 transition-colors"
                    title={rightSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                  >
                    <svg
                      className={`w-4 h-4 transition-transform ${rightSidebarCollapsed ? 'rotate-180' : ''}`}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                  </button>
                </div>
                {!rightSidebarCollapsed && (
                  <div className="flex-1 min-h-0 overflow-y-auto">
                    <FieldPanel
                      fields={activeVersion?.fields ?? []}
                      onRemoveField={schema.removeField}
                      onHighlightField={handleHighlightField}
                      onRenameField={handleRenameField}
                    />
                    {activeVersion && (
                      <ValidationPanel
                        fields={activeVersion.fields}
                        validation={activeVersion.validation}
                        onSetValidation={schema.setValidation}
                        onRemoveValidation={schema.removeValidation}
                      />
                    )}
                    <YamlPreview schema={schema.schema} />
                  </div>
                )}
              </div>
              <SuggestionPanel
                suggestions={suggestions}
                onScan={handleScanSuggestions}
                onAccept={applySuggestion}
                onAcceptAll={handleAcceptAllSuggestions}
                onDismiss={handleDismissSuggestion}
                onFocus={handleFocusSuggestion}
                activeSuggestionId={activeSuggestionId}
              />
            </div>
          ) : (
            <FileUpload onFileLoaded={handleFileLoaded} />
          )}
        </>
      )}

      {activeTab === 'extract' && (
        <div className="flex-1 min-h-0 overflow-hidden">
          <BatchExtractTab schema={schema.schema} onOpenFileInEditor={handleOpenFileInEditor} />
        </div>
      )}

      {/* Field dialog */}
      {(() => {
        const effectiveDialogSelection = dialogSelection ?? (spreadsheet.selection ? {
          sheetName: spreadsheet.activeSheet,
          selection: spreadsheet.selection,
        } : null);
        if (activeTab !== 'editor' || !showFieldDialog || !effectiveDialogSelection) {
          return null;
        }

        const dialogSheetData = effectiveDialogSelection.sheetName === spreadsheet.activeSheet
          ? spreadsheet.sheetData
          : (spreadsheet.workbook ? getSheetData(spreadsheet.workbook, effectiveDialogSelection.sheetName) : null);

        return (
          <FieldDialog
            selection={effectiveDialogSelection.selection}
            activeSheet={effectiveDialogSelection.sheetName}
            defaultSheet={spreadsheet.sheetNames[0] ?? ''}
            sheetData={dialogSheetData}
            initialField={editingField}
            title={fieldDialogTitle ?? undefined}
            onSave={handleSaveField}
            onCancel={handleCancelDialog}
          />
        );
      })()}

      {renamingField && (
        <FieldNameDialog
          title="Rename Field"
          initialValue={renamingField.name}
          confirmLabel="Save Name"
          onConfirm={handleConfirmRenameField}
          onCancel={handleCancelNameDialog}
        />
      )}


      {/* Mode indicator */}
      {activeTab === 'editor' && mode === 'discriminator' && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 bg-amber-500/90 text-black rounded-lg text-sm font-medium shadow-lg">
          Click a cell to add as discriminator
        </div>
      )}
    </div>
  );
}
