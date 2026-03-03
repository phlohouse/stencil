import { useState, useCallback } from 'react';
import { FileUpload } from './components/FileUpload';
import { SpreadsheetView } from './components/SpreadsheetView';
import { FieldPanel } from './components/FieldPanel';
import { FieldDialog } from './components/FieldDialog';
import { DiscriminatorPicker } from './components/DiscriminatorPicker';
import { VersionManager } from './components/VersionManager';
import { ValidationPanel } from './components/ValidationPanel';
import { ExportButton } from './components/ExportButton';
import { ImportButton } from './components/ImportButton';
import { useSpreadsheet } from './hooks/useSpreadsheet';
import { useSchema } from './hooks/useSchema';
import { formatAddress } from './lib/addressing';
import type { StencilField, StencilSchema, CellAddress } from './lib/types';
import { parseAddress } from './lib/addressing';

type Mode = 'select' | 'discriminator';

export default function App() {
  const spreadsheet = useSpreadsheet();
  const schema = useSchema();
  const [mode, setMode] = useState<Mode>('select');
  const [showFieldDialog, setShowFieldDialog] = useState(false);

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
      setShowFieldDialog(true);
    }
  }, [spreadsheet, mode, schema]);

  const handleSaveField = useCallback(
    (field: StencilField) => {
      schema.addField(field);
      setShowFieldDialog(false);
      spreadsheet.clearSelection();
    },
    [schema, spreadsheet],
  );

  const handleCancelDialog = useCallback(() => {
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

  if (!spreadsheet.workbook || !spreadsheet.sheetData) {
    return (
      <div className="min-h-screen bg-gray-950">
        <header className="px-6 py-4 border-b border-gray-800">
          <h1 className="text-xl font-bold text-white tracking-tight">
            Stencil Editor
          </h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Define Excel extraction schemas visually
          </p>
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
          <DiscriminatorPicker
            isActive={mode === 'discriminator'}
            currentCell={schema.schema.discriminator.cell}
            onToggle={handleToggleDiscriminator}
          />
          <ExportButton schema={schema.schema} />
        </div>
      </header>

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
        <div className="flex flex-col shrink-0">
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
        </div>
      </div>

      {/* Field dialog */}
      {showFieldDialog && spreadsheet.selection && (
        <FieldDialog
          selection={spreadsheet.selection}
          activeSheet={spreadsheet.activeSheet}
          defaultSheet={spreadsheet.sheetNames[0] ?? ''}
          sheetData={spreadsheet.sheetData}
          onSave={handleSaveField}
          onCancel={handleCancelDialog}
        />
      )}

      {/* Mode indicator */}
      {mode === 'discriminator' && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 bg-amber-500/90 text-black rounded-lg text-sm font-medium shadow-lg">
          Click a cell to set as discriminator
        </div>
      )}
    </div>
  );
}
