import { useState, useCallback } from 'react';
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
import { useSpreadsheet } from './hooks/useSpreadsheet';
import { useSchema } from './hooks/useSchema';
import { formatAddress, letterToColIndex } from './lib/addressing';
import type { StencilField, StencilSchema, CellAddress } from './lib/types';
import { parseAddress } from './lib/addressing';
import { invoke } from '@tauri-apps/api/core';

type Mode = 'select' | 'discriminator';
type AppTab = 'editor' | 'extract';

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

function parseRangeRef(rangeRef: string): { start: CellAddress; end: CellAddress; openEnded: boolean } | null {
  const [startRef, endRefMaybe] = rangeRef.split(':');
  if (!startRef) return null;

  let start: CellAddress;
  try {
    start = parseAddress(startRef.toUpperCase());
  } catch {
    return null;
  }

  if (!endRefMaybe) {
    return { start, end: start, openEnded: false };
  }

  const openEndedMatch = endRefMaybe.toUpperCase().match(/^([A-Z]+)$/);
  if (openEndedMatch?.[1]) {
    return {
      start,
      end: {
        col: letterToColIndex(openEndedMatch[1]),
        row: start.row,
      },
      openEnded: true,
    };
  }

  try {
    return {
      start,
      end: parseAddress(endRefMaybe.toUpperCase()),
      openEnded: false,
    };
  } catch {
    return null;
  }
}

function fieldContainsAddress(
  field: StencilField,
  addr: CellAddress,
  activeSheet: string,
  defaultSheet: string,
): boolean {
  if (field.cell) {
    const split = splitSheetRef(field.cell);
    if (split.sheet && split.sheet !== activeSheet) return false;
    if (!split.sheet && activeSheet !== defaultSheet) return false;
    try {
      const parsed = parseAddress(split.value.toUpperCase());
      return parsed.col === addr.col && parsed.row === addr.row;
    } catch {
      return false;
    }
  }

  if (field.range) {
    const split = splitSheetRef(field.range);
    if (split.sheet && split.sheet !== activeSheet) return false;
    if (!split.sheet && activeSheet !== defaultSheet) return false;
    const parsed = parseRangeRef(split.value);
    if (!parsed) return false;
    const minCol = Math.min(parsed.start.col, parsed.end.col);
    const maxCol = Math.max(parsed.start.col, parsed.end.col);
    const minRow = Math.min(parsed.start.row, parsed.end.row);
    const maxRow = parsed.openEnded ? Number.POSITIVE_INFINITY : Math.max(parsed.start.row, parsed.end.row);
    return addr.col >= minCol && addr.col <= maxCol && addr.row >= minRow && addr.row <= maxRow;
  }

  return false;
}

export default function App() {
  const spreadsheet = useSpreadsheet();
  const schema = useSchema();
  const [mode, setMode] = useState<Mode>('select');
  const [showFieldDialog, setShowFieldDialog] = useState(false);
  const [editingField, setEditingField] = useState<StencilField | null>(null);
  const [activeTab, setActiveTab] = useState<AppTab>('editor');

  const handleFileLoaded = useCallback(
    (buffer: ArrayBuffer) => {
      spreadsheet.loadFile(buffer);
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
      const defaultSheet = spreadsheet.sheetNames[0] ?? '';

      if (activeVersion) {
        const existing = activeVersion.fields.find((field) =>
          fieldContainsAddress(field, sel.start, spreadsheet.activeSheet, defaultSheet),
        );

        if (existing) {
          setEditingField(existing);
          setShowFieldDialog(true);
          return;
        }
      }

      setEditingField(null);
      setShowFieldDialog(true);
    }
  }, [spreadsheet, mode, schema]);

  const handleSaveField = useCallback(
    (field: StencilField) => {
      if (editingField) {
        if (field.name === editingField.name) {
          schema.updateField(editingField.name, field);
        } else {
          const validation = schema.activeVersion?.validation[editingField.name];
          schema.addField(field);
          if (validation) {
            schema.setValidation(field.name, validation);
          }
          schema.removeField(editingField.name);
        }
      } else {
        schema.addField(field);
      }
      setEditingField(null);
      setShowFieldDialog(false);
      spreadsheet.clearSelection();
    },
    [editingField, schema, spreadsheet],
  );

  const handleCancelDialog = useCallback(() => {
    setEditingField(null);
    setShowFieldDialog(false);
    spreadsheet.clearSelection();
  }, [spreadsheet]);

  const handleHighlightField = useCallback(
    (field: StencilField) => {
      if (field.cell) {
        const ref = field.cell.includes('!') ? field.cell.split('!')[1]! : field.cell;
        const addr = parseAddress(ref);
        spreadsheet.startSelection(addr);
        spreadsheet.endSelection();
      }
    },
    [spreadsheet],
  );

  const handleImport = useCallback(
    (imported: StencilSchema) => {
      schema.loadSchema(imported);
    },
    [schema],
  );

  const handleNew = useCallback(() => {
    spreadsheet.reset();
    schema.resetSchema();
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

  const handleOpenFileInEditor = useCallback(
    async ({ sourcePath, file }: { sourcePath: string; file?: File }) => {
      if (file) {
        const buffer = await file.arrayBuffer();
        spreadsheet.loadFile(buffer);
        setActiveTab('editor');
        return;
      }

      if (!isLikelyTauriRuntime()) {
        return;
      }

      const bytes = await invoke<number[]>('read_file_bytes', { filePath: sourcePath });
      const buffer = new Uint8Array(bytes).buffer;
      spreadsheet.loadFile(buffer);
      setActiveTab('editor');
    },
    [spreadsheet],
  );

  if ((!spreadsheet.workbook || !spreadsheet.sheetData) && activeTab === 'editor') {
    return (
      <div className="min-h-screen bg-gray-950 flex flex-col">
        <header className="px-6 py-4 border-b border-gray-800">
          <h1 className="text-xl font-bold text-white tracking-tight">
            Stencil Editor
          </h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Define Excel extraction schemas visually
          </p>
          <div className="mt-3 inline-flex rounded-lg border border-gray-700 bg-gray-900/60 p-1">
            <button
              onClick={() => setActiveTab('editor')}
              className="px-3 py-1.5 rounded text-xs font-medium bg-gray-800 text-white"
            >
              Schema Editor
            </button>
            <button
              onClick={() => setActiveTab('extract')}
              className="px-3 py-1.5 rounded text-xs font-medium text-gray-300 hover:text-white hover:bg-gray-800/60"
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
    <div className="h-screen flex flex-col bg-gray-950">
      {/* Top bar */}
      <header className="flex items-center justify-between px-4 py-2 border-b border-gray-800 bg-gray-950 shrink-0">
        <div className="flex items-center gap-4">
          <h1 className="text-sm font-bold text-white tracking-tight">
            Stencil Editor
          </h1>

          <div className="inline-flex rounded-lg border border-gray-700 bg-gray-900/60 p-1">
            <button
              onClick={() => setActiveTab('editor')}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                activeTab === 'editor'
                  ? 'bg-gray-800 text-white'
                  : 'text-gray-300 hover:text-white hover:bg-gray-800/60'
              }`}
            >
              Schema Editor
            </button>
            <button
              onClick={() => setActiveTab('extract')}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                activeTab === 'extract'
                  ? 'bg-gray-800 text-white'
                  : 'text-gray-300 hover:text-white hover:bg-gray-800/60'
              }`}
            >
              Batch Extract
            </button>
          </div>

          <button
            onClick={handleNew}
            className="px-2 py-1 text-xs text-gray-400 hover:text-white bg-gray-800 border border-gray-700 hover:border-gray-500 rounded transition-colors"
            title="New schema"
          >
            New
          </button>
          <div className="h-4 w-px bg-gray-700" />
          <input
            type="text"
            value={schema.schema.name}
            onChange={(e) => schema.setName(e.target.value)}
            placeholder="schema_name"
            className="px-2 py-1 bg-gray-900 border border-gray-700 rounded text-sm text-white font-mono placeholder:text-gray-600 focus:outline-none focus:border-blue-500 w-40"
          />
          <input
            type="text"
            value={schema.schema.description}
            onChange={(e) => schema.setDescription(e.target.value)}
            placeholder="Description"
            className="px-2 py-1 bg-gray-900 border border-gray-700 rounded text-sm text-gray-300 placeholder:text-gray-600 focus:outline-none focus:border-blue-500 w-64"
          />
        </div>
        <div className="flex items-center gap-3">
          <ImportButton onImport={handleImport} />
          {activeTab === 'editor' && (
            <DiscriminatorPicker
              isActive={mode === 'discriminator'}
              currentCell={schema.schema.discriminator.cell}
              onToggle={handleToggleDiscriminator}
            />
          )}
          <ExportButton schema={schema.schema} />
        </div>
      </header>

      {activeTab === 'editor' && (
        <>
          {/* Version bar */}
          <div className="flex items-center px-4 py-1.5 border-b border-gray-800 bg-gray-900/50 shrink-0">
            <span className="text-xs text-gray-500 mr-3">Versions:</span>
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
                  discriminatorCell={schema.schema.discriminator.cell}
                  onSwitchSheet={spreadsheet.switchSheet}
                  onStartSelection={handleStartSelection}
                  onExtendSelection={handleExtendSelection}
                  onEndSelection={handleSelectionEnd}
                />
              </div>

              {/* Right panel */}
              <div className="flex flex-col shrink-0 w-80 overflow-hidden">
                <FieldPanel
                  fields={activeVersion?.fields ?? []}
                  onRemoveField={schema.removeField}
                  onHighlightField={handleHighlightField}
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
      {activeTab === 'editor' && showFieldDialog && spreadsheet.selection && (
        <FieldDialog
          selection={spreadsheet.selection}
          activeSheet={spreadsheet.activeSheet}
          defaultSheet={spreadsheet.sheetNames[0] ?? ''}
          sheetData={spreadsheet.sheetData}
          initialField={editingField}
          onSave={handleSaveField}
          onCancel={handleCancelDialog}
        />
      )}

      {/* Mode indicator */}
      {activeTab === 'editor' && mode === 'discriminator' && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 bg-amber-500/90 text-black rounded-lg text-sm font-medium shadow-lg">
          Click a cell to set as discriminator
        </div>
      )}
    </div>
  );
}
