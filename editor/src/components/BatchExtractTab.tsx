import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { StencilField, StencilSchema, StencilVersion } from '../lib/types';
import { schemaToYaml } from '../lib/yaml-export';
import { parseWorkbook } from '../lib/excel';
import { colIndexToLetter, letterToColIndex, parseAddress } from '../lib/addressing';

interface DiscriminatorCheck {
  cell: string;
  value: string;
}

interface ExtractionError {
  file: string;
  error: string;
  kind?: string;
  sourcePath?: string;
  checkedCells?: DiscriminatorCheck[];
}

interface ExtractionResponse {
  filesScanned: number;
  rows: Record<string, unknown>[];
  errors: ExtractionError[];
  halted?: boolean;
  haltedReason?: string | null;
  haltedAtPath?: string | null;
}

interface BatchProgressPayload {
  currentFile: string;
}

interface BatchExtractTabProps {
  schema: StencilSchema;
  onOpenFileInEditor: (args: { sourcePath: string; file?: File }) => Promise<void> | void;
}

type Row = Record<string, unknown>;

interface WebSelectedFile {
  file: File;
  relativePath: string;
}

interface ParsedCellRef {
  sheet?: string;
  cell: string;
}

interface ParsedRange {
  sheet?: string;
  startCol: number;
  startRow: number;
  endCol: number;
  endRow?: number;
}

function isLikelyTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function getSchemaDiscriminatorCells(schema: StencilSchema): string[] {
  const cells = schema.discriminator.cells?.filter(Boolean) ?? [];
  if (cells.length > 0) return cells;
  if (schema.discriminator.cell) return [schema.discriminator.cell];
  return ['A1'];
}

function renderCell(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function flattenInto(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    target[path] = value;
    return;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      target[path] = '';
      return;
    }

    value.forEach((item, index) => {
      flattenInto(target, `${path}.${index}`, item);
    });
    return;
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      target[path] = '';
      return;
    }
    entries.forEach(([key, item]) => {
      flattenInto(target, `${path}.${key}`, item);
    });
    return;
  }

  target[path] = String(value);
}

function flattenRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    flattenInto(out, key, value);
  }
  return out;
}

function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const escape = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const header = columns.map(escape).join(',');
  const lines = rows.map((row) => columns.map((column) => escape(renderCell(row[column]))).join(','));
  return [header, ...lines].join('\n');
}

function parseSheetAndRef(ref: string): ParsedCellRef {
  const split = ref.split('!');
  if (split.length === 2) {
    return { sheet: split[0], cell: split[1] ?? '' };
  }
  return { cell: ref };
}

function parseRangeRef(rangeRef: string): ParsedRange {
  const { sheet, cell } = parseSheetAndRef(rangeRef);
  const [startRef, endRefMaybe] = cell.split(':');
  if (!startRef) throw new Error(`Invalid range: ${rangeRef}`);

  const start = parseAddress(startRef.toUpperCase());
  const endRef = endRefMaybe ?? startRef;

  const openEndedMatch = endRef.match(/^([A-Za-z]+)$/);
  if (openEndedMatch?.[1]) {
    return {
      sheet,
      startCol: start.col + 1,
      startRow: start.row + 1,
      endCol: letterToColIndex(openEndedMatch[1].toUpperCase()) + 1,
    };
  }

  const end = parseAddress(endRef.toUpperCase());
  return {
    sheet,
    startCol: start.col + 1,
    startRow: start.row + 1,
    endCol: end.col + 1,
    endRow: end.row + 1,
  };
}

function valueFromExcel(raw: unknown): unknown {
  if (raw == null) return null;
  if (raw instanceof Date) return raw.toISOString();
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') return raw;
  if (typeof raw === 'object') {
    if ('result' in raw) {
      return valueFromExcel((raw as { result?: unknown }).result);
    }
    if ('richText' in raw) {
      const rich = (raw as { richText?: Array<{ text?: string }> }).richText;
      return rich?.map((part) => part.text ?? '').join('') ?? '';
    }
    if ('text' in raw) {
      return String((raw as { text?: unknown }).text ?? '');
    }
    if ('error' in raw) {
      return String((raw as { error?: unknown }).error ?? '');
    }
  }
  return String(raw);
}

function resolveWorksheet(workbook: Awaited<ReturnType<typeof parseWorkbook>>, sheet?: string) {
  if (sheet) {
    const ws = workbook.getWorksheet(sheet);
    if (!ws) throw new Error(`Sheet '${sheet}' not found`);
    return ws;
  }
  const ws = workbook.worksheets[0];
  if (!ws) throw new Error('Workbook has no worksheets');
  return ws;
}

function readCell(workbook: Awaited<ReturnType<typeof parseWorkbook>>, ref: string): unknown {
  const { sheet, cell } = parseSheetAndRef(ref);
  const ws = resolveWorksheet(workbook, sheet);
  const addr = parseAddress(cell.toUpperCase());
  return valueFromExcel(ws.getCell(addr.row + 1, addr.col + 1).value);
}

function readRangeRows(workbook: Awaited<ReturnType<typeof parseWorkbook>>, rangeRef: string): unknown[][] {
  const range = parseRangeRef(rangeRef);
  const ws = resolveWorksheet(workbook, range.sheet);

  const rows: unknown[][] = [];
  const readRow = (rowIndex: number): unknown[] => {
    const row: unknown[] = [];
    for (let col = range.startCol; col <= range.endCol; col++) {
      row.push(valueFromExcel(ws.getCell(rowIndex, col).value));
    }
    return row;
  };

  if (range.endRow != null) {
    for (let row = range.startRow; row <= range.endRow; row++) rows.push(readRow(row));
    while (rows.length && rows[rows.length - 1]?.every((value) => value == null)) rows.pop();
    return rows;
  }

  const maxRow = Math.max(ws.rowCount, range.startRow);
  for (let row = range.startRow; row <= maxRow + 1; row++) {
    const values = readRow(row);
    if (values.every((value) => value == null)) break;
    rows.push(values);
  }

  return rows;
}

function toBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  return ['true', '1', 'yes', 'y'].includes(normalized);
}

function toDateString(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date value: ${String(value)}`);
  return date.toISOString().slice(0, 10);
}

function toDateTimeString(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid datetime value: ${String(value)}`);
  return date.toISOString();
}

function coerceScalar(value: unknown, type?: string): unknown {
  if (value == null) return null;
  switch (type) {
    case 'str':
      return String(value);
    case 'int': {
      const parsed = typeof value === 'number' ? value : Number(String(value));
      if (!Number.isFinite(parsed)) throw new Error(`Invalid int value: ${String(value)}`);
      return Math.trunc(parsed);
    }
    case 'float': {
      const parsed = typeof value === 'number' ? value : Number(String(value));
      if (!Number.isFinite(parsed)) throw new Error(`Invalid float value: ${String(value)}`);
      return parsed;
    }
    case 'bool':
      return toBoolean(value);
    case 'date':
      return toDateString(value);
    case 'datetime':
      return toDateTimeString(value);
    default:
      return value;
  }
}

function inferFieldType(field: StencilField): string {
  if (field.type) return field.type;
  if (field.computed) return 'any';
  if (field.cell) return 'str';
  if (field.range) return 'list[str]';
  return 'any';
}

function extractFieldFromWorkbook(workbook: Awaited<ReturnType<typeof parseWorkbook>>, field: StencilField): unknown {
  const type = inferFieldType(field);

  if (field.computed) return null;

  if (field.cell) return coerceScalar(readCell(workbook, field.cell), type);
  if (!field.range) return null;

  const rows = readRangeRows(workbook, field.range);

  if (type === 'table') {
    if (!rows.length) return [];

    if (field.tableOrientation === 'vertical') {
      const parsed = parseRangeRef(field.range);
      const maxCols = rows.reduce((max, row) => Math.max(max, row.length), 0);
      if (maxCols <= 1) return [];

      const headers = rows.map((row, index) => {
        const rowKey = String(parsed.startRow + index);
        return field.columns?.[rowKey] ?? String(row[0] ?? `row_${index}`);
      });
      const records: Row[] = [];

      for (let c = 1; c < maxCols; c++) {
        const record: Row = {};
        for (let r = 0; r < rows.length; r++) {
          record[headers[r] ?? `row_${r}`] = rows[r]?.[c] ?? null;
        }
        records.push(record);
      }

      return records;
    }

    const parsed = parseRangeRef(field.range);
    const headers = field.columns
      ? Array.from({ length: parsed.endCol - parsed.startCol + 1 }, (_, i) => {
        const letter = colIndexToLetter(parsed.startCol - 1 + i);
        return field.columns?.[letter] ?? letter;
      })
      : rows[0]?.map((value, index) => String(value ?? `col_${index}`)) ?? [];
    const dataRows = field.columns ? rows : rows.slice(1);
    return dataRows.map((row) => {
      const record: Row = {};
      headers.forEach((header, i) => {
        record[header] = row[i] ?? null;
      });
      return record;
    });
  }

  if (type === 'dict' || type.startsWith('dict[')) {
    const map: Row = {};
    const valueType = type.includes('int]') ? 'int' : type.includes('float]') ? 'float' : 'str';
    rows.forEach((row) => {
      const key = row[0] == null ? '' : String(row[0]);
      map[key] = coerceScalar(row[1], valueType);
    });
    return map;
  }

  if (type.startsWith('list[')) {
    const elementType = type.slice(5, -1);
    return rows.map((row) => coerceScalar(row[0], elementType));
  }

  return rows.map((row) => row[0] ?? null);
}

function matchVersionByDiscriminatorCells(
  schema: StencilSchema,
  workbook: Awaited<ReturnType<typeof parseWorkbook>>,
  discriminatorCells: string[],
): { version: StencilVersion; matchedCell: string; checkedCells: DiscriminatorCheck[] } | null {
  const checkedCells: DiscriminatorCheck[] = [];

  for (const cellRef of discriminatorCells) {
    const raw = readCell(workbook, cellRef);
    const discriminatorValue = raw == null ? '' : String(raw).trim();
    checkedCells.push({ cell: cellRef, value: discriminatorValue });
    const version = schema.versions.find((v) => v.discriminatorValue === discriminatorValue);
    if (version) {
      return { version, matchedCell: cellRef, checkedCells };
    }
  }

  return null;
}

async function extractWebFiles(
  schema: StencilSchema,
  files: WebSelectedFile[],
  discriminatorCells: string[],
  stopOnUnmatched: boolean,
  onProgress?: (path: string) => void,
): Promise<ExtractionResponse> {
  const rows: Row[] = [];
  const errors: ExtractionError[] = [];
  let halted = false;
  let haltedReason: string | null = null;
  let haltedAtPath: string | null = null;

  for (const selected of files) {
    const { file, relativePath } = selected;
    onProgress?.(relativePath);
    try {
      const workbook = await parseWorkbook(await file.arrayBuffer());
      const matched = matchVersionByDiscriminatorCells(schema, workbook, discriminatorCells);

      if (!matched) {
        const checkedCells = discriminatorCells.map((cell) => {
          try {
            const value = readCell(workbook, cell);
            return { cell, value: value == null ? '' : String(value).trim() };
          } catch {
            return { cell, value: '<error>' };
          }
        });

        errors.push({
          file: file.name,
          sourcePath: relativePath,
          kind: 'discriminator_mismatch',
          error: 'No schema version matched discriminator values from configured discriminator cells',
          checkedCells,
        });

        if (stopOnUnmatched) {
          halted = true;
          haltedReason = `Stopped at ${relativePath} because discriminator did not match`;
          haltedAtPath = relativePath;
          break;
        }

        continue;
      }

      const row: Row = {
        _source_file: file.name,
        _source_path: relativePath,
        _discriminator_cell: matched.matchedCell,
      };

      for (const field of matched.version.fields) {
        row[field.name] = extractFieldFromWorkbook(workbook, field);
      }

      rows.push(row);
    } catch (e) {
      errors.push({
        file: file.name,
        sourcePath: relativePath,
        kind: 'extraction_error',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return {
    filesScanned: files.length,
    rows,
    errors,
    halted,
    haltedReason,
    haltedAtPath,
  };
}

async function collectWebDirectoryFiles(
  dirHandle: { entries: () => AsyncIterable<[string, any]> },
  prefix = '',
): Promise<WebSelectedFile[]> {
  const files: WebSelectedFile[] = [];
  for await (const [name, entry] of dirHandle.entries()) {
    if (entry.kind === 'file' && entry.getFile) {
      const file = await entry.getFile();
      if (/\.(xlsx|xlsm|xls)$/i.test(file.name)) {
        files.push({ file, relativePath: `${prefix}${name}` });
      }
      continue;
    }

    if (entry.kind === 'directory' && entry.entries) {
      const nested = await collectWebDirectoryFiles(entry as { entries: () => AsyncIterable<[string, any]> }, `${prefix}${name}/`);
      files.push(...nested);
    }
  }
  return files;
}

export function BatchExtractTab({ schema, onOpenFileInEditor }: BatchExtractTabProps) {
  const [directoryPath, setDirectoryPath] = useState('');
  const [globFilter, setGlobFilter] = useState('*');
  const [stopOnUnmatched, setStopOnUnmatched] = useState(true);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ExtractionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [webFiles, setWebFiles] = useState<WebSelectedFile[]>([]);
  const [resumeFromPath, setResumeFromPath] = useState<string | null>(null);
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = folderInputRef.current;
    if (!input) return;
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
  }, []);

  useEffect(() => {
    if (!isLikelyTauriRuntime()) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    void listen<BatchProgressPayload>('batch-extract-progress', (event) => {
      if (cancelled) return;
      setCurrentFile(event.payload.currentFile);
    }).then((dispose) => {
      if (cancelled) {
        dispose();
        return;
      }
      unlisten = dispose;
    });

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  const hasSchema = schema.versions.some((v) => v.fields.length > 0);

  const toRegexFromGlob = (glob: string): RegExp => {
    const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`, 'i');
  };

  const filterWebFilesByGlob = (files: WebSelectedFile[], glob: string): WebSelectedFile[] => {
    const matcher = toRegexFromGlob(glob.trim() || '*');
    return files.filter(({ file, relativePath }) => matcher.test(relativePath) || matcher.test(file.name));
  };

  const flattenedRows = useMemo(
    () => (result?.rows ?? []).map(flattenRow),
    [result?.rows],
  );

  const columns = useMemo(() => {
    if (!flattenedRows.length) return [] as string[];
    const all = new Set<string>();
    flattenedRows.forEach((row) => Object.keys(row).forEach((k) => all.add(k)));
    const preferred = ['_source_file', '_source_path', '_discriminator_cell'];
    const orderedPreferred = preferred.filter((k) => all.has(k));
    const remaining = [...all].filter((k) => !preferred.includes(k)).sort();
    return [...orderedPreferred, ...remaining];
  }, [flattenedRows]);

  const webMatchedFiles = useMemo(() => filterWebFilesByGlob(webFiles, globFilter), [webFiles, globFilter]);
  const discriminatorCells = useMemo(() => getSchemaDiscriminatorCells(schema), [schema]);

  const mergeContinuation = (
    previous: ExtractionResponse | null,
    next: ExtractionResponse,
    resumedFrom: string | null,
  ): ExtractionResponse => {
    if (!previous || !resumedFrom) return next;

    return {
      filesScanned: previous.filesScanned + next.filesScanned,
      rows: [...previous.rows, ...next.rows],
      errors: [
        ...previous.errors.filter((entry) => entry.sourcePath !== resumedFrom),
        ...next.errors,
      ],
      halted: next.halted,
      haltedReason: next.haltedReason,
      haltedAtPath: next.haltedAtPath,
    };
  };

  const handleRun = async (isContinuation = false) => {
    setError(null);
    setCurrentFile(null);
    if (!isContinuation) {
      setResult(null);
      setResumeFromPath(null);
    }

    if (!hasSchema) {
      setError('Schema is incomplete. Add at least one field.');
      return;
    }

    if (isLikelyTauriRuntime()) {
      if (!directoryPath.trim()) {
        setError('Enter a directory path.');
        return;
      }

      setRunning(true);
      try {
        const response = await invoke<ExtractionResponse>('run_stencil_on_directory', {
          schemaYaml: schemaToYaml(schema),
          directoryPath: directoryPath.trim(),
          globFilter: globFilter.trim() || '*',
          stopOnUnmatched,
          resumeFromPath: isContinuation ? resumeFromPath : null,
        });
        const merged = mergeContinuation(result, response, isContinuation ? resumeFromPath : null);
        setResult(merged);
        setResumeFromPath(merged.halted ? (merged.haltedAtPath ?? null) : null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setRunning(false);
        setCurrentFile(null);
      }
      return;
    }

    if (!webMatchedFiles.length) {
      setError('No files matched the current glob filter in web mode.');
      return;
    }

    setRunning(true);
    try {
      const filesToProcess = isContinuation && resumeFromPath
        ? (() => {
            const idx = webMatchedFiles.findIndex((f) => f.relativePath === resumeFromPath);
            return idx >= 0 ? webMatchedFiles.slice(idx) : webMatchedFiles;
          })()
        : webMatchedFiles;

      const response = await extractWebFiles(
        schema,
        filesToProcess,
        discriminatorCells,
        stopOnUnmatched,
        (path) => setCurrentFile(path),
      );
      const merged = mergeContinuation(result, response, isContinuation ? resumeFromPath : null);
      setResult(merged);
      setResumeFromPath(merged.halted ? (merged.haltedAtPath ?? null) : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
      setCurrentFile(null);
    }
  };

  const handleChooseFolder = async () => {
    setError(null);

    if (isLikelyTauriRuntime()) {
      setError('Native folder picker is unavailable in this build. Enter a directory path manually.');
      return;
    }

    const picker = (globalThis as { showDirectoryPicker?: () => Promise<any> }).showDirectoryPicker;
    if (picker) {
      try {
        const dirHandle = await picker();
        const files = await collectWebDirectoryFiles(dirHandle);
        setWebFiles(files);
        setDirectoryPath(dirHandle.name ?? `${files.length} file(s) selected`);
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setError(e instanceof Error ? e.message : String(e));
      }
      return;
    }

    folderInputRef.current?.click();
  };

  const handleWebFolderChanged = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
      .filter((file) => /\.(xlsx|xlsm|xls)$/i.test(file.name))
      .map((file) => ({
        file,
        relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
      }));

    setWebFiles(files);
    const rootFolder = files[0]?.relativePath?.split('/')[0] ?? '';
    setDirectoryPath(rootFolder || `${files.length} file(s) selected`);
  };

  const handleDownloadCsv = () => {
    if (!flattenedRows.length || !columns.length) return;
    const csv = toCsv(columns, flattenedRows);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${schema.name || 'stencil'}-extracted.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleOpenErrorFile = async (entry: ExtractionError) => {
    if (!entry.sourcePath) return;

    if (isLikelyTauriRuntime()) {
      await onOpenFileInEditor({ sourcePath: entry.sourcePath });
      return;
    }

    const selected = webFiles.find((item) => item.relativePath === entry.sourcePath || item.file.name === entry.file);
    if (!selected) {
      setError('Could not find that file in the currently selected web folder.');
      return;
    }

    await onOpenFileInEditor({ sourcePath: selected.relativePath, file: selected.file });
  };

  return (
    <div className="h-full flex flex-col bg-gray-950">
      <div className="border-b border-gray-800 px-4 py-3">
        <h2 className="text-sm font-semibold text-white">Batch Extract</h2>
        <p className="text-xs text-gray-400 mt-1">
          Apply the current stencil schema to every Excel file in a directory and preview dataframe-like output.
        </p>
        <p className="text-xs text-blue-300/90 mt-2">
          Uses the current schema in the editor (same as YAML Preview), including unsaved changes.
        </p>
      </div>

      <div className="p-4 border-b border-gray-800 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 min-w-[360px] flex-1">
          <span className="text-xs text-gray-400">Directory</span>
          <input
            value={directoryPath}
            onChange={(e) => setDirectoryPath(e.target.value)}
            placeholder={isLikelyTauriRuntime() ? '/absolute/path/to/excel-files' : 'Choose a folder'}
            className="px-3 py-2 bg-gray-900 border border-gray-700 rounded text-sm text-gray-100 placeholder:text-gray-600 focus:outline-none focus:border-blue-500"
            readOnly={!isLikelyTauriRuntime()}
          />
        </label>

        <label className="flex flex-col gap-1 w-56">
          <span className="text-xs text-gray-400">Glob Filter</span>
          <input
            value={globFilter}
            onChange={(e) => setGlobFilter(e.target.value)}
            placeholder="*.xlsx"
            className="px-3 py-2 bg-gray-900 border border-gray-700 rounded text-sm text-gray-100 placeholder:text-gray-600 focus:outline-none focus:border-blue-500"
          />
        </label>

        <label className="flex flex-col gap-1 w-72">
          <span className="text-xs text-gray-400">Discriminator Cells (from schema)</span>
          <div className="px-3 py-2 bg-gray-900 border border-gray-700 rounded text-xs text-gray-300 font-mono whitespace-nowrap overflow-hidden text-ellipsis">
            {discriminatorCells.join(', ')}
          </div>
        </label>

        <button
          onClick={handleChooseFolder}
          className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded text-sm font-medium"
        >
          Choose Folder
        </button>
        <button
          onClick={() => void handleRun(false)}
          disabled={running}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed text-white rounded text-sm font-medium"
        >
          {running ? 'Running...' : 'Run Extraction'}
        </button>
        <button
          onClick={() => void handleRun(true)}
          disabled={running || !resumeFromPath}
          className="px-4 py-2 bg-amber-600 hover:bg-amber-700 disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed text-white rounded text-sm font-medium"
        >
          Continue From Halt
        </button>
        <button
          onClick={handleDownloadCsv}
          disabled={!result?.rows.length}
          className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed text-white rounded text-sm font-medium"
        >
          Download CSV
        </button>

        <label className="basis-full inline-flex items-center gap-2 text-xs text-gray-400 mt-1">
          <input
            type="checkbox"
            checked={stopOnUnmatched}
            onChange={(e) => setStopOnUnmatched(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-gray-600 bg-gray-900"
          />
          Stop batch when discriminator is not matched
        </label>

        <div className="basis-full text-[11px] text-gray-500">
          {isLikelyTauriRuntime()
            ? 'Matched files are calculated when extraction runs.'
            : `Matched files: ${webMatchedFiles.length} of ${webFiles.length}`}
        </div>
        {running && currentFile && (
          <div className="basis-full text-xs text-blue-300 font-mono">
            Current file: {currentFile}
          </div>
        )}
        <div className="basis-full text-xs text-gray-500">
          Running extraction does not read an exported file; it runs against the schema currently loaded in this app.
        </div>
        {!isLikelyTauriRuntime() && (
          <div className="basis-full text-xs text-gray-500">
            In web mode, folder selection loads browser-accessible files only and applies glob filtering client-side.
          </div>
        )}
      </div>

      <input
        ref={folderInputRef}
        type="file"
        className="hidden"
        multiple
        onChange={handleWebFolderChanged}
      />

      {error && (
        <div className="mx-4 mt-4 px-3 py-2 rounded border border-red-500/40 bg-red-500/10 text-red-200 text-sm">{error}</div>
      )}

      {result?.halted && (
        <div className="mx-4 mt-4 px-3 py-2 rounded border border-amber-500/40 bg-amber-500/10 text-amber-200 text-sm">
          {result.haltedReason ?? 'Batch stopped due to discriminator mismatch.'}
          {resumeFromPath ? (
            <span className="ml-2 text-amber-100/90">Use "Continue From Halt" after adding the missing version.</span>
          ) : null}
        </div>
      )}

      {result && (
        <div className="px-4 pt-4">
          <div className="text-xs text-gray-400">
            Files scanned: <span className="text-gray-200">{result.filesScanned}</span>
            {' | '}
            Rows extracted: <span className="text-gray-200">{result.rows.length}</span>
            {' | '}
            Errors: <span className="text-gray-200">{result.errors.length}</span>
          </div>
        </div>
      )}

      {result?.errors.length ? (
        <div className="mx-4 mt-3 rounded border border-amber-500/40 bg-amber-500/10 overflow-hidden">
          <div className="px-3 py-2 text-xs text-amber-200 font-medium border-b border-amber-500/30">Extraction errors</div>
          <div className="max-h-44 overflow-auto">
            {result.errors.map((entry, i) => (
              <div key={`${entry.file}-${i}`} className="px-3 py-2 text-xs text-amber-100 border-t border-amber-500/20 first:border-t-0">
                <div className="flex items-center justify-between gap-3">
                  <div className="font-mono break-all">{entry.file}</div>
                  {entry.kind === 'discriminator_mismatch' && entry.sourcePath && (
                    <button
                      onClick={() => void handleOpenErrorFile(entry)}
                      className="shrink-0 px-2 py-1 rounded bg-gray-800 border border-gray-600 hover:border-gray-500 text-gray-200"
                    >
                      Open in Editor
                    </button>
                  )}
                </div>
                <div className="text-amber-200/90 mt-0.5">{entry.error}</div>
                {entry.checkedCells?.length ? (
                  <div className="mt-1 text-[11px] text-amber-100/90">
                    Checked: {entry.checkedCells.map((c) => `${c.cell}='${c.value}'`).join(', ')}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="flex-1 min-h-0 p-4">
        {result?.rows.length && columns.length ? (
          <div className="h-full overflow-auto border border-gray-800 rounded">
            <table className="min-w-full border-collapse text-xs">
              <thead className="sticky top-0 z-10 bg-gray-900">
                <tr>
                  {columns.map((column) => (
                    <th
                      key={column}
                      className="border-b border-gray-700 px-2 py-1 text-left font-medium text-gray-300 whitespace-nowrap"
                    >
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                    {flattenedRows.map((row, i) => (
                  <tr key={i} className="odd:bg-gray-950 even:bg-gray-900/40">
                    {columns.map((column) => (
                      <td
                        key={`${i}-${column}`}
                        className="border-t border-gray-800 px-2 py-1 text-gray-200 align-top max-w-[420px] whitespace-pre-wrap break-words"
                      >
                        {renderCell(row[column])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="h-full grid place-items-center border border-dashed border-gray-800 rounded text-sm text-gray-500">
            Run extraction to populate dataframe preview.
          </div>
        )}
      </div>
    </div>
  );
}
