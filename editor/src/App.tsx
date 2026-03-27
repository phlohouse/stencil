import { useState, useCallback, useEffect, useRef } from 'react';
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
import { CommandPalette, type CommandPaletteItem } from './components/CommandPalette';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { useSpreadsheet } from './hooks/useSpreadsheet';
import { useSchema } from './hooks/useSchema';
import { formatAddress, formatRange, normalizeRange } from './lib/addressing';
import type { StencilField, StencilSchema, CellAddress } from './lib/types';
import { parseAddress, letterToColIndex } from './lib/addressing';
import { invoke } from '@tauri-apps/api/core';
import { scanWorkbookForSuggestions, type SchemaSuggestion, type RemapFieldSuggestion } from './lib/suggestions';
import { getSheetData, type CellValue, type Workbook } from './lib/excel';
import { saveVersionFile, loadVersionFile } from './lib/storage';

type Mode = 'select' | 'discriminator';
type AppTab = 'editor' | 'extract';
const CONFIG_SIDEBAR_COLLAPSED_KEY = 'stencil-editor-config-sidebar-collapsed';
const SUGGESTIONS_SIDEBAR_COLLAPSED_KEY = 'stencil-editor-suggestions-sidebar-collapsed';

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
  const [selectedFieldName, setSelectedFieldName] = useState<string | null>(null);
  const [resizeSuggestionId, setResizeSuggestionId] = useState<string | null>(null);
  const [suggestionPreview, setSuggestionPreview] = useState<SuggestionPreviewState | null>(null);
  const [activeTab, setActiveTab] = useState<AppTab>('editor');
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [rightSidebarCollapsed, setRightSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem(CONFIG_SIDEBAR_COLLAPSED_KEY) === 'true';
  });
  const [sidebarSplitPercent, setSidebarSplitPercent] = useState(50);
  const sidebarResizing = useRef(false);
  const sidebarContainerRef = useRef<HTMLDivElement>(null);
  const [configWidth, setConfigWidth] = useState(320);
  const [suggestionsWidth, setSuggestionsWidth] = useState(320);
  const [suggestionsCollapsed, setSuggestionsCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem(SUGGESTIONS_SIDEBAR_COLLAPSED_KEY) === 'true';
  });
  const [yamlExpanded, setYamlExpanded] = useState(true);
  const [suggestions, setSuggestions] = useState<SchemaSuggestion[]>([]);
  const [activeSuggestionId, setActiveSuggestionId] = useState<string | null>(null);
  const [pendingSuggestionId, setPendingSuggestionId] = useState<string | null>(null);
  const [renamingField, setRenamingField] = useState<StencilField | null>(null);
  const currentFileBuffer = useRef<ArrayBuffer | null>(null);

  const [pendingVersionAdd, setPendingVersionAdd] = useState<{
    sourceDiscValue: string;
    copiedFields: StencilField[];
    previousWorkbook: Workbook | null;
  } | null>(null);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    if (typeof window !== 'undefined') {
      return (localStorage.getItem('stencil-theme') as 'dark' | 'light') ?? 'dark';
    }
    return 'dark';
  });

  useEffect(() => {
    document.documentElement.classList.toggle('light', theme === 'light');
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('stencil-theme', theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(CONFIG_SIDEBAR_COLLAPSED_KEY, String(rightSidebarCollapsed));
  }, [rightSidebarCollapsed]);

  useEffect(() => {
    localStorage.setItem(SUGGESTIONS_SIDEBAR_COLLAPSED_KEY, String(suggestionsCollapsed));
  }, [suggestionsCollapsed]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandPaletteOpen((current) => !current);
      }
      if (event.key === 'Escape') {
        setCommandPaletteOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Auto-capture fingerprints when fields change (but NOT when just the workbook changes,
  // since swapping to a new spreadsheet would overwrite the old fingerprints)
  const prevFieldsRef = useRef<StencilField[] | undefined>(undefined);
  useEffect(() => {
    const fields = schema.activeVersion?.fields;
    if (!fields || fields.length === 0 || !spreadsheet.workbook) {
      console.log('[fingerprint-effect] skipping: fields=', fields?.length, 'workbook=', !!spreadsheet.workbook);
      return;
    }
    if (fields === prevFieldsRef.current) {
      console.log('[fingerprint-effect] skipping: fields ref unchanged');
      return;
    }
    console.log('[fingerprint-effect] fields changed, capturing fingerprints');
    prevFieldsRef.current = fields;
    schema.captureFingerprints(spreadsheet.workbook);
  }, [schema.activeVersion?.fields, spreadsheet.workbook, schema.captureFingerprints]);

  const injectRemapSuggestions = useCallback(
    (remaps: import('./lib/field-fingerprints').RemapSuggestion[], fields: StencilField[]) => {
      const remapSuggestions: RemapFieldSuggestion[] = remaps.map((r) => {
        const field = fields.find((f) => f.name === r.fieldName);
        const ref = r.newRef;
        const sheetSep = ref.indexOf('!');
        const sheetName = sheetSep >= 0 ? ref.slice(0, sheetSep) : spreadsheet.sheetNames[0] ?? '';

        const updatedField: StencilField = {
          ...field!,
          ...(field?.cell ? { cell: r.newRef } : { range: r.newRef }),
          // Clear column mappings — columns likely shifted, let the dialog re-derive them
          columns: undefined,
        };

        return {
          id: `remap:${r.fieldName}`,
          kind: 'remap' as const,
          sheetName,
          score: r.confidence,
          reasons: [
            `Field moved from ${r.oldRef}`,
            `Matched values: ${r.matchedValues.slice(0, 3).join(', ')}`,
          ],
          fieldName: r.fieldName,
          oldRef: r.oldRef,
          newRef: r.newRef,
          field: updatedField,
          targetRef: r.newRef,
        };
      });

      setSuggestions(remapSuggestions);
      setActiveSuggestionId(remapSuggestions[0]?.id ?? null);
      setSuggestionPreview(null);
    },
    [spreadsheet.sheetNames],
  );

  // Complete pending version add once the NEW workbook is loaded
  useEffect(() => {
    if (!pendingVersionAdd || !spreadsheet.workbook) {
      if (pendingVersionAdd) console.log('[pending-version] waiting for workbook...');
      return;
    }
    // Wait until the workbook has actually changed (new file loaded)
    if (spreadsheet.workbook === pendingVersionAdd.previousWorkbook) {
      console.log('[pending-version] workbook unchanged, still waiting...');
      return;
    }
    console.log('[pending-version] new workbook loaded, completing version add');

    const { sourceDiscValue, copiedFields } = pendingVersionAdd;
    setPendingVersionAdd(null);

    const remaps = schema.suggestRemappings(
      sourceDiscValue,
      spreadsheet.workbook,
      copiedFields,
    );
    if (remaps.length > 0) {
      injectRemapSuggestions(remaps, copiedFields);
    }
  }, [pendingVersionAdd, spreadsheet.workbook, schema, injectRemapSuggestions]);

  const handleSwitchVersion = useCallback(
    (index: number) => {
      // Save current file for current version before switching
      const currentVersion = schema.activeVersion;
      if (currentVersion?.id && currentVersion.discriminatorValue && currentFileBuffer.current) {
        saveVersionFile(currentVersion.id, currentVersion.discriminatorValue, currentFileBuffer.current).catch(() => { /* ignore */ });
      }

      schema.setActiveVersionIndex(index);

      // Clear UI state
      setSuggestions([]);
      setActiveSuggestionId(null);
      setSuggestionPreview(null);
      setDialogSelection(null);
      setShowFieldDialog(false);
      setEditingField(null);
      setResizeFieldName(null);
      setMoveFieldName(null);
      spreadsheet.clearSelection();

      // Load the file associated with the new version
      const newVersion = schema.schema.versions[index];
      if (newVersion?.id && newVersion.discriminatorValue) {
        loadVersionFile(newVersion.id, newVersion.discriminatorValue)
          .then((buffer) => {
            if (buffer) {
              spreadsheet.loadFromBuffer(buffer);
              currentFileBuffer.current = buffer;
            } else {
              currentFileBuffer.current = null;
              spreadsheet.reset();
            }
          })
          .catch(() => { /* ignore */ });
      }
    },
    [schema, spreadsheet],
  );

  const handleFileLoaded = useCallback(
    (buffer: ArrayBuffer) => {
      spreadsheet.loadFile(buffer);
      currentFileBuffer.current = buffer;
      setSuggestions([]);
      setActiveSuggestionId(null);
      setSuggestionPreview(null);
      setDialogSelection(null);

      const activeVersion = schema.activeVersion;
      if (activeVersion?.id && activeVersion.discriminatorValue) {
        saveVersionFile(activeVersion.id, activeVersion.discriminatorValue, buffer).catch(() => { /* ignore */ });
      }
    },
    [spreadsheet, schema.activeVersion],
  );

  const handleSelectionEnd = useCallback((selectionOverride?: { start: CellAddress; end: CellAddress }) => {
    const sel = selectionOverride ?? spreadsheet.selection;
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
        clickedFieldRef.current = false;
        setSelectedFieldName(moveFieldName);
        setMoveFieldName(null);
        spreadsheet.clearSelection();
        return;
      }

      if (activeVersion && resizeFieldName) {
        const existing = activeVersion.fields.find((field) => field.name === resizeFieldName);
        if (existing) {
          setSelectedFieldName(existing.name);
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

      if (clickedSuggestionRef.current) {
        clickedSuggestionRef.current = false;
        return;
      }

      if (clickedFieldRef.current) {
        clickedFieldRef.current = false;
        return;
      }

      setResizeFieldName(null);
      setSelectedFieldName(null);
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
      setSelectedFieldName(field.name);
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
      setSelectedFieldName(field.name);
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
    setSelectedFieldName(null);
  }, [spreadsheet, schema]);

  const handleToggleDiscriminator = useCallback(() => {
    setMode((m) => (m === 'discriminator' ? 'select' : 'discriminator'));
  }, []);

  const handleAddDiscriminatorRef = useCallback((ref: string, value?: string | null) => {
    schema.setDiscriminator(ref);
    if (value && value.trim()) {
      schema.setVersionDiscriminatorValue(value.trim());
    }
    setMode('select');
    spreadsheet.clearSelection();
  }, [schema, spreadsheet]);

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
    setSelectedFieldName(fieldName);
    setMoveFieldName(fieldName);
  }, []);

  const handleStartResizeSuggestion = useCallback((suggestionId: string) => {
    setResizeFieldName(null);
    setResizeSuggestionId(suggestionId);
  }, []);

  const openFieldEditor = useCallback((field: StencilField) => {
    const selection = getFieldSelection(field, spreadsheet.workbook, spreadsheet.sheetNames[0] ?? '');
    setSelectedFieldName(field.name);
    if (selection) {
      setDialogSelection({
        sheetName: selection.sheet ?? (spreadsheet.sheetNames[0] ?? spreadsheet.activeSheet),
        selection: {
          start: selection.start,
          end: selection.end,
        },
      });
    } else {
      setDialogSelection({
        sheetName: spreadsheet.activeSheet,
        selection: { start: { col: 0, row: 0 }, end: { col: 0, row: 0 } },
      });
    }
    setEditingField(field);
    setEditingExistingFieldName(field.name);
    setFieldDialogTitle('Edit Field');
    setShowFieldDialog(true);
  }, [spreadsheet.activeSheet, spreadsheet.sheetNames, spreadsheet.workbook]);

  const clickedFieldRef = useRef(false);

  const handleSelectFieldFromSheet = useCallback((fieldName: string) => {
    clickedFieldRef.current = true;
    setSelectedFieldName(fieldName);
  }, []);

  const handleEditFieldFromSheet = useCallback((fieldName: string) => {
    const field = schema.activeVersion?.fields.find((entry) => entry.name === fieldName);
    if (!field) return;
    clickedFieldRef.current = false;
    openFieldEditor(field);
  }, [openFieldEditor, schema.activeVersion?.fields]);

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

    if (suggestion.kind === 'remap') {
      const remapField = suggestion.field;
      const remapSelection = getFieldSelection(
        remapField,
        spreadsheet.workbook,
        spreadsheet.sheetNames[0] ?? '',
      );
      if (!remapSelection) return;

      if (remapSelection.sheet && remapSelection.sheet !== spreadsheet.activeSheet) {
        spreadsheet.switchSheet(remapSelection.sheet);
      }

      spreadsheet.startSelection(remapSelection.start);
      spreadsheet.extendSelection(remapSelection.end);
      spreadsheet.endSelection();
      setDialogSelection({
        sheetName: remapSelection.sheet ?? (spreadsheet.sheetNames[0] ?? ''),
        selection: {
          start: remapSelection.start,
          end: remapSelection.end,
        },
      });
      setEditingField(remapField);
      setEditingExistingFieldName(suggestion.fieldName);
      setPendingSuggestionId(suggestion.id);
      setFieldDialogTitle('Accept Remap');
      setShowFieldDialog(true);
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

      if (suggestion.kind === 'remap') {
        const existing = schema.activeVersion?.fields.find((f) => f.name === suggestion.fieldName);
        if (existing) {
          if (existing.cell) {
            schema.updateField(suggestion.fieldName, { cell: suggestion.newRef });
          } else if (existing.range) {
            schema.updateField(suggestion.fieldName, { range: suggestion.newRef });
          }
        }
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

  const clickedSuggestionRef = useRef(false);

  const handleClickSuggestionOnSheet = useCallback((suggestionId: string) => {
    const suggestion = suggestions.find((s) => s.id === suggestionId);
    if (suggestion) {
      setActiveSuggestionId(suggestionId);
      clickedSuggestionRef.current = true;
    }
  }, [suggestions]);

  const handleFocusSuggestion = useCallback((suggestion: SchemaSuggestion) => {
    let rawRef: string | undefined;
    let selectionField: { name: string; cell?: string; range?: string };

    if (suggestion.kind === 'discriminator') {
      rawRef = suggestion.cellRef;
      selectionField = { name: suggestion.id, cell: suggestion.cellRef };
    } else if (suggestion.kind === 'remap') {
      rawRef = suggestion.newRef;
      selectionField = { name: suggestion.fieldName, ...(suggestion.newRef.includes(':') ? { range: suggestion.newRef } : { cell: suggestion.newRef }) };
    } else {
      rawRef = suggestion.field.cell ?? suggestion.field.range;
      selectionField = { name: suggestion.field.name, cell: suggestion.field.cell, range: suggestion.field.range };
    }
    if (!rawRef) return;

    const selection = getFieldSelection(selectionField, spreadsheet.workbook, spreadsheet.sheetNames[0] ?? '');
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

  const handleAddVersion = useCallback(
    (discriminatorValue: string, copyFromIndex?: number, newFileBuffer?: ArrayBuffer) => {
      const sourceVersion =
        copyFromIndex != null ? schema.schema.versions[copyFromIndex] : undefined;
      const sourceDiscValue = sourceVersion?.discriminatorValue;
      const copiedFields = sourceVersion?.fields.map((f) => ({ ...f }));
      const newVersionId = schema.addVersion(discriminatorValue, copyFromIndex);

      if (newFileBuffer) {
        currentFileBuffer.current = newFileBuffer;
        saveVersionFile(newVersionId, discriminatorValue, newFileBuffer).catch(() => { /* ignore */ });
        spreadsheet.loadFromBuffer(newFileBuffer, true);
      }

      // Check for remap suggestions using the copied fields directly
      // (React state hasn't re-rendered yet so we can't read from activeVersion)
      if (newFileBuffer && sourceDiscValue && copiedFields) {
        setPendingVersionAdd({
          sourceDiscValue,
          copiedFields,
          previousWorkbook: spreadsheet.workbook,
        });
        return;
      }

      if (sourceDiscValue && copiedFields && spreadsheet.workbook) {
        const remaps = schema.suggestRemappings(
          sourceDiscValue,
          spreadsheet.workbook,
          copiedFields,
        );
        if (remaps.length > 0) {
          injectRemapSuggestions(remaps, copiedFields);
        }
      }
    },
    [injectRemapSuggestions, schema, spreadsheet],
  );

  const handleGuessDiscriminator = useCallback(
    async (file: File): Promise<string | null> => {
      const cells = schema.schema.discriminator.cells;
      if (!cells || cells.length === 0) return null;

      try {
        const buffer = await file.arrayBuffer();
        const { parseWorkbook, getCellValue, getSheetNames } = await import('./lib/excel');
        const wb = await parseWorkbook(buffer);
        const sheetNames = getSheetNames(wb);
        const defaultSheet = sheetNames[0] ?? '';

        const values: string[] = [];
        for (const cellRef of cells) {
          const sheetSep = cellRef.indexOf('!');
          const sheetName = sheetSep >= 0 ? cellRef.slice(0, sheetSep) : defaultSheet;
          const addr = sheetSep >= 0 ? cellRef.slice(sheetSep + 1) : cellRef;
          const val = getCellValue(wb, sheetName, addr);
          if (val != null) values.push(String(val).trim());
        }

        return values.filter(Boolean).join(' ') || null;
      } catch {
        return null;
      }
    },
    [schema.schema.discriminator.cells],
  );

  const handleEditFieldFromPanel = useCallback((field: StencilField) => {
    openFieldEditor(field);
  }, [openFieldEditor]);

  const handleConfirmRenameField = useCallback((nextName: string) => {
    if (!renamingField) return;
    renameField(renamingField, nextName);
    setRenamingField(null);
  }, [renameField, renamingField]);

  const handleCancelNameDialog = useCallback(() => {
    setRenamingField(null);
  }, []);

  const activeVersion = schema.activeVersion;

  const commandPaletteItems: CommandPaletteItem[] = [
    {
      id: 'global:new',
      label: 'New schema',
      group: 'Global',
      keywords: ['create reset schema'],
      onSelect: handleNew,
    },
    {
      id: 'global:editor-tab',
      label: 'Open schema editor',
      group: 'Global',
      keywords: ['tab editor schema'],
      onSelect: () => setActiveTab('editor'),
    },
    {
      id: 'global:extract-tab',
      label: 'Open batch extract',
      group: 'Global',
      keywords: ['tab extract batch'],
      onSelect: () => setActiveTab('extract'),
    },
    {
      id: 'global:scan',
      label: 'Scan workbook for suggestions',
      group: 'Global',
      keywords: ['suggestions scan detect'],
      onSelect: handleScanSuggestions,
    },
    {
      id: 'global:discriminator',
      label: mode === 'discriminator' ? 'Exit discriminator mode' : 'Enter discriminator mode',
      group: 'Global',
      keywords: ['discriminator version'],
      onSelect: handleToggleDiscriminator,
    },
  ];

  if (suggestions.length > 0) {
    commandPaletteItems.push({
      id: 'global:accept-all',
      label: 'Accept all suggestions',
      group: 'Global',
      keywords: ['suggestions accept all'],
      onSelect: handleAcceptAllSuggestions,
    });
  }

  for (const version of schema.schema.versions) {
    const index = schema.schema.versions.findIndex((entry) => entry === version);
    commandPaletteItems.push({
      id: `version:${version.id ?? version.discriminatorValue}:${index}`,
      label: `Switch to version ${version.discriminatorValue}`,
      group: 'Versions',
      hint: index === schema.activeVersionIndex ? 'Current' : undefined,
      keywords: ['version switch discriminator'],
      onSelect: () => handleSwitchVersion(index),
    });
  }

  for (const sheetName of spreadsheet.sheetNames) {
    commandPaletteItems.push({
      id: `sheet:${sheetName}`,
      label: `Go to sheet ${sheetName}`,
      group: 'Sheets',
      hint: sheetName === spreadsheet.activeSheet ? 'Current' : undefined,
      keywords: ['sheet tab workbook'],
      onSelect: () => {
        setActiveTab('editor');
        spreadsheet.switchSheet(sheetName);
      },
    });
  }

  for (const field of activeVersion?.fields ?? []) {
    commandPaletteItems.push({
      id: `field:focus:${field.name}`,
      label: `Focus field ${field.name}`,
      group: 'Fields',
      hint: field.type === 'table' ? 'Table' : (field.type ?? 'str'),
      keywords: [field.name, field.cell ?? field.range ?? '', 'field focus jump'],
      onSelect: () => {
        setActiveTab('editor');
        handleHighlightField(field);
      },
    });
    commandPaletteItems.push({
      id: `field:edit:${field.name}`,
      label: `Edit field ${field.name}`,
      group: 'Fields',
      keywords: [field.name, 'field edit'],
      onSelect: () => {
        setActiveTab('editor');
        handleEditFieldFromPanel(field);
      },
    });
  }

  for (const suggestion of suggestions) {
    const label = suggestion.kind === 'discriminator'
      ? `Focus suggestion ${suggestion.discriminatorValue}`
      : suggestion.kind === 'remap'
        ? `Focus remap ${suggestion.fieldName}`
        : `Focus suggestion ${suggestion.field.name}`;
    const acceptLabel = suggestion.kind === 'discriminator'
      ? `Accept discriminator ${suggestion.discriminatorValue}`
      : suggestion.kind === 'remap'
        ? `Accept remap ${suggestion.fieldName}`
        : `Accept suggestion ${suggestion.field.name}`;
    commandPaletteItems.push({
      id: `suggestion:focus:${suggestion.id}`,
      label,
      group: 'Suggestions',
      keywords: ['suggestion focus jump', suggestion.id],
      onSelect: () => {
        setActiveTab('editor');
        handleFocusSuggestion(suggestion);
      },
    });
    commandPaletteItems.push({
      id: `suggestion:accept:${suggestion.id}`,
      label: acceptLabel,
      group: 'Suggestions',
      keywords: ['suggestion accept apply', suggestion.id],
      onSelect: () => {
        setActiveTab('editor');
        applySuggestion(suggestion);
      },
    });
  }

  if ((!spreadsheet.workbook || !spreadsheet.sheetData) && activeTab === 'editor') {
    return (
      <div className="min-h-screen bg-bg flex flex-col">
        <header className="border-b border-cell-border bg-bg px-6 py-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0">
              <h1 className="text-xl font-bold text-text tracking-tight">
                Stencil Editor
              </h1>
              <p className="mt-1 text-sm text-text-muted">
                Define Excel extraction schemas visually.
              </p>
            </div>
            <div className="inline-flex h-8 rounded-lg border border-border bg-surface/65">
          <Button
            onClick={() => setActiveTab('editor')}
            variant="secondary"
            size="sm"
            className="h-8 rounded-r-none rounded-l-[calc(var(--radius)-1px)] border-0 px-3 text-xs shadow-none"
          >
            Schema Editor
          </Button>
          <Button
            onClick={() => setActiveTab('extract')}
            variant="ghost"
            size="sm"
            className="h-8 rounded-l-none rounded-r-[calc(var(--radius)-1px)] border-0 px-3 text-xs text-text-secondary hover:text-text"
          >
            Batch Extract
          </Button>
            </div>
          </div>
        </header>
        <FileUpload onFileLoaded={handleFileLoaded} />
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-bg">
      {/* Top bar */}
      <CommandPalette
        open={commandPaletteOpen}
        onOpenChange={setCommandPaletteOpen}
        items={commandPaletteItems}
      />
      <header className="shrink-0 border-b border-cell-border bg-bg px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <div className="min-w-0 pr-1">
              <div className="text-sm font-bold text-text tracking-tight">
                Stencil Editor
              </div>
              <div className="text-[11px] text-text-muted">
                Visual schema authoring for spreadsheets
              </div>
            </div>

            <div className="inline-flex h-8 rounded-lg border border-border bg-surface/65">
            <Button
              onClick={() => setActiveTab('editor')}
              variant={activeTab === 'editor' ? 'secondary' : 'ghost'}
              size="sm"
              className={`h-8 rounded-r-none rounded-l-[calc(var(--radius)-1px)] border-0 px-3 text-xs ${
                activeTab === 'editor' ? 'text-text shadow-none' : 'text-text-secondary hover:text-text'
              }`}
            >
              Schema Editor
            </Button>
            <Button
              onClick={() => setActiveTab('extract')}
              variant={activeTab === 'extract' ? 'secondary' : 'ghost'}
              size="sm"
              className={`h-8 rounded-l-none rounded-r-[calc(var(--radius)-1px)] border-0 px-3 text-xs ${
                activeTab === 'extract' ? 'text-text shadow-none' : 'text-text-secondary hover:text-text'
              }`}
            >
              Batch Extract
            </Button>
          </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={handleNew}
                variant="outline"
                size="sm"
                className="h-8 bg-elevated px-3 text-xs text-text-secondary hover:text-text"
                title="New schema"
              >
                New
              </Button>
              {spreadsheet.workbook && (
                <label title="Load a different spreadsheet without resetting the schema">
                  <Button
                    asChild
                    variant="outline"
                    size="sm"
                    className="h-8 cursor-pointer bg-elevated px-3 text-xs text-text-secondary hover:text-text"
                  >
                    <span>Open File</span>
                  </Button>
                  <input
                    type="file"
                    accept=".xlsx,.xls,.xlsm"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        const reader = new FileReader();
                        reader.onload = (ev) => {
                          const buffer = ev.target?.result as ArrayBuffer;
                          if (buffer) handleFileLoaded(buffer);
                        };
                        reader.readAsArrayBuffer(file);
                      }
                      e.target.value = '';
                    }}
                    className="hidden"
                  />
                </label>
              )}
              <div className="mx-1 hidden h-5 w-px bg-border md:block" />
              <Input
                type="text"
                value={schema.schema.name}
                onChange={(e) => schema.setName(e.target.value)}
                placeholder="schema_name"
                className="h-8 w-44 bg-surface px-2.5 text-sm font-mono text-text placeholder:text-text-faint shadow-none"
              />
              <Input
                type="text"
                value={schema.schema.description}
                onChange={(e) => schema.setDescription(e.target.value)}
                placeholder="Description"
                className="h-8 w-72 bg-surface px-2.5 text-sm text-text-secondary placeholder:text-text-faint shadow-none"
              />
            </div>
        </div>
          <div className="flex flex-1 min-w-[320px] flex-wrap items-center justify-end gap-2.5">
          {activeTab === 'editor' && (
            <DiscriminatorPicker
              isActive={mode === 'discriminator'}
              currentCell={schema.schema.discriminator.cell}
              cells={schema.schema.discriminator.cells}
              workbook={spreadsheet.workbook}
              sheetNames={spreadsheet.sheetNames}
              activeSheet={spreadsheet.activeSheet}
              onToggle={handleToggleDiscriminator}
              onAddRef={handleAddDiscriminatorRef}
              onRemoveCell={schema.removeDiscriminator}
              onClearAll={schema.clearDiscriminators}
            />
          )}
            <div className="inline-flex items-center gap-2">
              <Button
                onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
                variant="outline"
                size="sm"
                className="h-8 px-2.5 text-sm bg-elevated"
                title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
              >
                {theme === 'dark' ? '☀️' : '🌙'}
              </Button>
              <div className="h-5 w-px bg-border" />
              <div className="inline-flex overflow-hidden rounded-lg border border-border bg-surface">
                <ImportButton onImport={handleImport} />
                <ExportButton schema={schema.schema} />
              </div>
            </div>
          </div>
        </div>
      </header>

      {activeTab === 'editor' && (
        <>
          {/* Version bar */}
          <div className="flex items-center gap-3 border-b border-cell-border bg-surface/55 px-4 py-2 shrink-0">
            <span className="rounded-full border border-border bg-bg/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted">
              Versions
            </span>
            <VersionManager
              versions={schema.schema.versions}
              activeIndex={schema.activeVersionIndex}
              onSwitchVersion={handleSwitchVersion}
              onAddVersion={handleAddVersion}
              onRemoveVersion={schema.removeVersion}
              onUpdateDiscriminatorValue={schema.setVersionDiscriminatorValue}
              onGuessDiscriminator={handleGuessDiscriminator}
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
                  activeFieldName={selectedFieldName}
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
                  onSelectField={handleSelectFieldFromSheet}
                  onEditField={handleEditFieldFromSheet}
                  onDeleteField={schema.removeField}
                  onStartResizeSuggestion={handleStartResizeSuggestion}
                  onEndSelection={handleSelectionEnd}
                  onClickSuggestion={handleClickSuggestionOnSheet}
                />
              </div>

              {/* Right panel */}
              {!rightSidebarCollapsed && (
                <div
                  className="w-px shrink-0 cursor-col-resize bg-border hover:bg-accent/60 transition-colors"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    const startX = e.clientX;
                    const startW = configWidth;
                    const onMouseMove = (ev: MouseEvent) => {
                      setConfigWidth(Math.max(200, Math.min(600, startW - (ev.clientX - startX))));
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
                className={`flex flex-col shrink-0 overflow-hidden bg-surface/85 backdrop-blur-sm ${rightSidebarCollapsed ? 'border-l border-border' : ''}`}
                style={{ width: rightSidebarCollapsed ? 40 : configWidth }}
              >
                <div className={`flex items-center ${rightSidebarCollapsed ? 'justify-center' : 'justify-between px-3'} py-2 border-b border-border shrink-0`}>
                  {!rightSidebarCollapsed && <span className="text-xs font-semibold text-text">Configuration</span>}
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
                  <div ref={sidebarContainerRef} className="flex-1 min-h-0 flex flex-col overflow-hidden">
                    <div className="overflow-y-auto" style={yamlExpanded ? { height: `${sidebarSplitPercent}%` } : { flex: 1 }}>
                      <FieldPanel
                        fields={activeVersion?.fields ?? []}
                        onRemoveField={schema.removeField}
                        onHighlightField={handleHighlightField}
                        onEditField={handleEditFieldFromPanel}
                      />
                      {activeVersion && (
                        <ValidationPanel
                          fields={activeVersion.fields}
                          validation={activeVersion.validation}
                          onSetValidation={schema.setValidation}
                          onRemoveValidation={schema.removeValidation}
                        />
                      )}
                    </div>
                    {yamlExpanded && (
                      <div
                        className="h-px shrink-0 cursor-row-resize bg-border hover:bg-accent/60 transition-colors"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          sidebarResizing.current = true;
                          const container = sidebarContainerRef.current;
                          if (!container) return;
                          const onMouseMove = (ev: MouseEvent) => {
                            if (!sidebarResizing.current) return;
                            const rect = container.getBoundingClientRect();
                            const percent = ((ev.clientY - rect.top) / rect.height) * 100;
                            setSidebarSplitPercent(Math.max(10, Math.min(90, percent)));
                          };
                          const onMouseUp = () => {
                            sidebarResizing.current = false;
                            document.removeEventListener('mousemove', onMouseMove);
                            document.removeEventListener('mouseup', onMouseUp);
                          };
                          document.addEventListener('mousemove', onMouseMove);
                          document.addEventListener('mouseup', onMouseUp);
                        }}
                      />
                    )}
                    <div className="min-h-0 shrink-0" style={yamlExpanded ? { height: `${100 - sidebarSplitPercent}%` } : undefined}>
                      <YamlPreview schema={schema.schema} expanded={yamlExpanded} onToggleExpanded={() => setYamlExpanded(!yamlExpanded)} />
                    </div>
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
                width={suggestionsWidth}
                onWidthChange={setSuggestionsWidth}
                collapsed={suggestionsCollapsed}
                onCollapsedChange={setSuggestionsCollapsed}
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

        const otherVersionFieldNames = Array.from(new Set(
          schema.schema.versions
            .filter((_, i) => i !== schema.activeVersionIndex)
            .flatMap((v) => v.fields.map((f) => f.name)),
        ));

        return (
          <FieldDialog
            selection={effectiveDialogSelection.selection}
            activeSheet={effectiveDialogSelection.sheetName}
            defaultSheet={spreadsheet.sheetNames[0] ?? ''}
            sheetData={dialogSheetData}
            initialField={editingField}
            title={fieldDialogTitle ?? undefined}
            otherVersionFieldNames={otherVersionFieldNames}
            currentVersionFieldNames={(schema.activeVersion?.fields ?? []).map((f) => f.name)}
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
