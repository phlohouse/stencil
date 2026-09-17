import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SheetData, CellValue, CellStyle } from '../lib/excel';
import type { CellAddress, GestureResult, Selection, StencilField } from '../lib/types';
import type { SchemaSuggestion } from '../lib/suggestions';
import {
  clampCell,
  clampRegionShift,
  colIndexToLetter,
  letterToColIndex,
  normalizeRange,
  parseAddress,
  type GridBounds,
} from '../lib/addressing';
import { resolveOpenEndedEndRow } from '../lib/open-ended';
import { findMatchKey, findMatches, stepMatchIndex } from '../lib/find';
import {
  DEFAULT_COL_WIDTH,
  buildGridGeometry,
  cellRect,
  clampColWidth,
  isMergeStart,
  mergeExtent,
  selectionToTsv,
  visibleWindow,
} from '../lib/grid';
import { Checkbox } from './ui/checkbox';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from './ui/context-menu';

type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

interface SpreadsheetViewProps {
  sheetData: SheetData;
  sheetNames: string[];
  activeSheet: string;
  selection: Selection | null;
  /** Bump to scroll a programmatic selection into view. */
  revealToken?: number;
  /** Bump to return keyboard focus to the grid (e.g. after the field dialog closes). */
  focusToken?: number;
  /** Hidden columns are toggled from the status bar. */
  showHiddenColumns: boolean;
  /** Open the field dialog for the current selection. */
  onDefineField: () => void;
  fields: StencilField[];
  activeFieldName?: string | null;
  discriminatorCells?: string[];
  suggestions?: SchemaSuggestion[];
  activeSuggestionId?: string | null;
  suggestionPreviewSelection?: Selection | null;
  onSetSelection: (selection: Selection) => void;
  onEndSelection: (result: GestureResult) => void;
  onClearSelection: () => void;
  onSelectField: (fieldName: string) => void;
  onEditField: (fieldName: string) => void;
  onDeleteField: (fieldName: string) => void;
}

interface FieldRegion {
  fieldName: string;
  start: CellAddress;
  end: CellAddress;
}

interface SuggestionRegion {
  suggestionId: string;
  label: string;
  start: CellAddress;
  end: CellAddress;
}

interface GestureState {
  kind: 'select' | 'move-field' | 'resize-field' | 'resize-suggestion';
  pointerStart: { x: number; y: number };
  /** Cell under the pointer when the gesture started. */
  originCell: CellAddress;
  crossedThreshold: boolean;
  fieldName?: string;
  suggestionId?: string;
  /** Region the gesture started from, resolved for open-ended ranges. */
  sourceRange?: { start: CellAddress; end: CellAddress };
  handle?: ResizeHandle;
  anchor?: CellAddress;
}

const DRAG_THRESHOLD_PX = 4;
const EDGE_SCROLL_PX = 36;
const MAX_EDGE_SCROLL_STEP = 24;

function splitSheetRef(ref: string): { sheet?: string; value: string } {
  const idx = ref.indexOf('!');
  if (idx < 0) return { value: ref };
  return {
    sheet: ref.slice(0, idx),
    value: ref.slice(idx + 1),
  };
}

function parseRange(
  rangeRef: string,
): { start: CellAddress; end: CellAddress; openEnded: boolean } | null {
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

function formatCellDisplay(value: CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'string' && value.startsWith('=')) {
    const fnMatch = value.match(/^=([A-Z][A-Z0-9._]*)\(/i);
    if (fnMatch?.[1]) return `=${fnMatch[1].toUpperCase()}(...)`;
    return '=...';
  }
  return String(value);
}

function styleToCSS(style: CellStyle | undefined): React.CSSProperties | undefined {
  if (!style) return undefined;
  const css: React.CSSProperties = {};
  if (style.bold) css.fontWeight = 'bold';
  if (style.italic) css.fontStyle = 'italic';
  if (style.fontSize) css.fontSize = `${Math.max(style.fontSize * 0.85, 9)}px`;
  if (style.borderTop) css.borderTop = style.borderTop;
  if (style.borderBottom) css.borderBottom = style.borderBottom;
  if (style.borderLeft) css.borderLeft = style.borderLeft;
  if (style.borderRight) css.borderRight = style.borderRight;
  if (style.hAlign) css.textAlign = style.hAlign as React.CSSProperties['textAlign'];
  return Object.keys(css).length ? css : undefined;
}

/** The corner that stays fixed while `handle` is dragged. */
function resizeAnchor(handle: ResizeHandle, region: { start: CellAddress; end: CellAddress }): CellAddress {
  const { start: s, end: e } = region;
  switch (handle) {
    case 'nw':
    case 'n':
    case 'w':
      return e;
    case 'se':
    case 's':
    case 'e':
      return s;
    case 'ne':
      return { col: s.col, row: e.row };
    case 'sw':
      return { col: e.col, row: s.row };
  }
}

/** The corner the pointer is dragging, given the current pointer cell. */
function resizeDragCorner(
  handle: ResizeHandle,
  region: { start: CellAddress; end: CellAddress },
  cell: CellAddress,
): CellAddress {
  const { start: s, end: e } = region;
  switch (handle) {
    case 'nw':
    case 'ne':
    case 'sw':
    case 'se':
      return cell;
    case 'n':
      return { col: s.col, row: cell.row };
    case 's':
      return { col: e.col, row: cell.row };
    case 'w':
      return { col: cell.col, row: s.row };
    case 'e':
      return { col: cell.col, row: e.row };
  }
}

/** A cell on the handle's own edge, used to seed a resize gesture. */
function handleCornerCell(handle: ResizeHandle, region: { start: CellAddress; end: CellAddress }): CellAddress {
  const { start: s, end: e } = region;
  switch (handle) {
    case 'nw':
    case 'n':
      return s;
    case 'se':
    case 's':
      return e;
    case 'ne':
    case 'e':
      return { col: e.col, row: s.row };
    case 'sw':
    case 'w':
      return { col: s.col, row: e.row };
  }
}

function offsetPointForResizeHandle(
  handle: ResizeHandle,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const inset = 6;
  switch (handle) {
    case 'nw':
      return { x: clientX + inset, y: clientY + inset };
    case 'ne':
      return { x: clientX - inset, y: clientY + inset };
    case 'sw':
      return { x: clientX + inset, y: clientY - inset };
    case 'se':
      return { x: clientX - inset, y: clientY - inset };
    case 'n':
      return { x: clientX, y: clientY + inset };
    case 's':
      return { x: clientX, y: clientY - inset };
    case 'w':
      return { x: clientX + inset, y: clientY };
    case 'e':
      return { x: clientX - inset, y: clientY };
  }
}

function exceededDragThreshold(start: { x: number; y: number }, event: MouseEvent): boolean {
  return Math.abs(event.clientX - start.x) > DRAG_THRESHOLD_PX
    || Math.abs(event.clientY - start.y) > DRAG_THRESHOLD_PX;
}

/**
 * Resolve the cell a gesture is currently over. Resize handles sit just outside
 * the cell border, so the pointer is nudged inwards for those gestures.
 */
function gesturePoint(
  state: GestureState,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  if ((state.kind === 'resize-field' || state.kind === 'resize-suggestion') && state.handle) {
    return offsetPointForResizeHandle(state.handle, clientX, clientY);
  }
  return { x: clientX, y: clientY };
}

function resolveGestureSelection(
  state: GestureState,
  cell: CellAddress,
  bounds: GridBounds,
): Selection | null {
  switch (state.kind) {
    case 'select':
      return normalizeRange(state.originCell, clampCell(cell, bounds));
    case 'move-field': {
      if (!state.sourceRange) return null;
      return clampRegionShift(
        state.sourceRange,
        cell.col - state.originCell.col,
        cell.row - state.originCell.row,
        bounds,
      );
    }
    case 'resize-field':
    case 'resize-suggestion': {
      if (!state.anchor || !state.sourceRange || !state.handle) return null;
      const dragged = clampCell(resizeDragCorner(state.handle, state.sourceRange, cell), bounds);
      return normalizeRange(state.anchor, dragged);
    }
  }
}

function selectionsEqual(a: Selection, b: Selection): boolean {
  return a.start.col === b.start.col && a.start.row === b.start.row
    && a.end.col === b.end.col && a.end.row === b.end.row;
}

export function SpreadsheetView({
  sheetData,
  sheetNames,
  activeSheet,
  selection,
  revealToken,
  focusToken,
  showHiddenColumns,
  onDefineField,
  fields,
  activeFieldName,
  discriminatorCells,
  suggestions,
  activeSuggestionId,
  suggestionPreviewSelection,
  onSetSelection,
  onEndSelection,
  onClearSelection,
  onSelectField,
  onEditField,
  onDeleteField,
}: SpreadsheetViewProps) {
  const tableRef = useRef<HTMLDivElement>(null);
  const overlayContainerRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<GestureState | null>(null);
  const rafIdRef = useRef(0);
  const autoScrollRafRef = useRef(0);
  const latestPointerRef = useRef({ x: 0, y: 0 });
  const lastCellRef = useRef<CellAddress | null>(null);
  const [gesture, setGesture] = useState<{ kind: GestureState['kind']; fieldName?: string; suggestionId?: string } | null>(null);
  const [hoveredFieldName, setHoveredFieldName] = useState<string | null>(null);
  // Widths the reader dragged, per sheet and column index.
  const [colWidthOverrides, setColWidthOverrides] = useState<Record<string, Record<number, number>>>({});
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findMatchCase, setFindMatchCase] = useState(false);
  const [findIndex, setFindIndex] = useState(0);
  const findInputRef = useRef<HTMLInputElement>(null);
  const [viewport, setViewport] = useState({ scrollTop: 0, scrollLeft: 0, width: 0, height: 0 });
  const [metrics, setMetrics] = useState<{ sheet: string; rowHeight: number; headerHeight: number } | null>(null);
  const activeMetrics = metrics?.sheet === activeSheet ? metrics : null;

  const geometry = useMemo(
    () => buildGridGeometry(sheetData, {
      includeHiddenCols: showHiddenColumns,
      rowHeight: activeMetrics?.rowHeight,
      headerHeight: activeMetrics?.headerHeight,
      colWidthOverrides: colWidthOverrides[activeSheet],
    }),
    [sheetData, showHiddenColumns, activeMetrics, colWidthOverrides, activeSheet],
  );
  const bounds = useMemo<GridBounds>(
    () => ({ maxCol: Math.max(0, geometry.cols - 1), maxRow: Math.max(0, geometry.rows - 1) }),
    [geometry.cols, geometry.rows],
  );
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;

  // Extra columns beyond the viewport keep the off-window spacer out of sight
  // for the usual sheet widths, so horizontally scrolled sheets still show
  // column letters and gridlines instead of a blank strip.
  const gridWindow = useMemo(
    () => visibleWindow(geometry, viewport, 4, 12),
    [geometry, viewport],
  );

  // Empty cells past the used range, so the canvas reads as a spreadsheet
  // instead of stopping at the last column of data.
  const fillerCols = useMemo(() => {
    if (!viewport.width) return 0;
    const free = viewport.width - geometry.totalWidth;
    return free > DEFAULT_COL_WIDTH / 2 ? Math.min(60, Math.ceil(free / DEFAULT_COL_WIDTH)) : 0;
  }, [viewport.width, geometry.totalWidth]);
  // The last filler column takes whatever width is left, so the canvas ends
  // flush with the container instead of leaving a gap or a scrollbar.
  const fillerWidths = useMemo(() => {
    if (fillerCols === 0) return [] as number[];
    const free = viewport.width - geometry.totalWidth;
    const widths = Array.from({ length: fillerCols }, () => DEFAULT_COL_WIDTH);
    widths[fillerCols - 1] = Math.max(
      DEFAULT_COL_WIDTH,
      free - (fillerCols - 1) * DEFAULT_COL_WIDTH,
    );
    return widths;
  }, [fillerCols, viewport.width, geometry.totalWidth]);
  const fillerRows = useMemo(() => {
    if (!viewport.height) return 0;
    const free = viewport.height - geometry.totalHeight;
    return free > geometry.rowHeight ? Math.min(40, Math.floor(free / geometry.rowHeight)) : 0;
  }, [viewport.height, geometry.totalHeight, geometry.rowHeight]);
  const visibleColSpan = Math.max(0, gridWindow.lastCol - gridWindow.firstCol + 1);
  const renderedRows = useMemo(() => {
    const rows: number[] = [];
    for (let row = gridWindow.firstRow; row <= gridWindow.lastRow; row += 1) rows.push(row);
    return rows;
  }, [gridWindow.firstRow, gridWindow.lastRow]);
  const renderedCols = useMemo(() => {
    const cols: number[] = [];
    for (let col = gridWindow.firstCol; col <= gridWindow.lastCol; col += 1) {
      if (geometry.colWidths[col] > 0) cols.push(col);
    }
    return cols;
  }, [geometry.colWidths, gridWindow.firstCol, gridWindow.lastCol]);
  const renderedColSet = useMemo(() => new Set(renderedCols), [renderedCols]);

  const normalizedSelection = useMemo(() => {
    if (!selection) return null;
    return normalizeRange(selection.start, selection.end);
  }, [selection]);

  /** Excel draws a selection as one continuous block, not per-cell borders. */
  const selectionRect = useMemo(() => {
    if (!normalizedSelection) return null;
    return cellRect(
      geometry,
      normalizedSelection.start.col,
      normalizedSelection.start.row,
      normalizedSelection.end.col,
      normalizedSelection.end.row,
    );
  }, [geometry, normalizedSelection]);

  const mappedFieldCells = useMemo(() => {
    const cells = new Map<string, string>();
    const regions: FieldRegion[] = [];
    const defaultSheet = sheetNames[0] ?? '';

    const shouldIncludeFieldRef = (ref: string): string | null => {
      const split = splitSheetRef(ref);
      if (!split.sheet && activeSheet !== defaultSheet) return null;
      if (split.sheet && split.sheet !== activeSheet) return null;
      return split.value;
    };

    for (const field of fields) {
      if (field.cell) {
        const ref = shouldIncludeFieldRef(field.cell);
        if (!ref) continue;
        try {
          const parsed = parseAddress(ref.toUpperCase());
          // The reference may point outside the used range of this sheet.
          if (parsed.col < 0 || parsed.row < 0 || parsed.col >= geometry.cols || parsed.row >= geometry.rows) {
            continue;
          }
          regions.push({ fieldName: field.name, start: parsed, end: parsed });
          if (parsed.row >= gridWindow.firstRow && parsed.row <= gridWindow.lastRow && renderedColSet.has(parsed.col)) {
            cells.set(`${colIndexToLetter(parsed.col)}${parsed.row + 1}`, field.name);
          }
        } catch {
          // Ignore invalid refs in view rendering.
        }
        continue;
      }

      if (field.range) {
        const ref = shouldIncludeFieldRef(field.range);
        if (!ref) continue;

        const parsed = parseRange(ref);
        if (!parsed) continue;

        const startCol = Math.min(parsed.start.col, parsed.end.col);
        const endCol = Math.max(parsed.start.col, parsed.end.col);
        const startRow = Math.min(parsed.start.row, parsed.end.row);
        const endRow = parsed.openEnded
          ? resolveOpenEndedEndRow(sheetData, {
              startRow,
              startCol,
              endCol,
              blankRows: field.blankRows,
            })
          : Math.max(parsed.start.row, parsed.end.row);

        if (endRow < startRow) continue;

        // Clip the drawn region to the used range, like the sheet itself.
        const clippedStartCol = Math.max(0, startCol);
        const clippedEndCol = Math.min(geometry.cols - 1, endCol);
        const clippedStartRow = Math.max(0, startRow);
        const clippedEndRow = Math.min(geometry.rows - 1, endRow);
        if (clippedEndCol < clippedStartCol || clippedEndRow < clippedStartRow) continue;

        regions.push({
          fieldName: field.name,
          start: { col: clippedStartCol, row: clippedStartRow },
          end: { col: clippedEndCol, row: clippedEndRow },
        });

        for (let row = Math.max(clippedStartRow, gridWindow.firstRow); row <= Math.min(clippedEndRow, gridWindow.lastRow); row += 1) {
          for (let col = clippedStartCol; col <= clippedEndCol; col += 1) {
            if (!renderedColSet.has(col)) continue;
            cells.set(`${colIndexToLetter(col)}${row + 1}`, field.name);
          }
        }
      }
    }
    return { cells, regions };
  }, [activeSheet, fields, geometry.cols, geometry.rows, renderedColSet, sheetData, sheetNames, gridWindow.firstRow, gridWindow.lastRow]);

  const suggestionCells = useMemo(() => {
    const cells = new Map<string, SuggestionRegion>();
    const regions: SuggestionRegion[] = [];
    const defaultSheet = sheetNames[0] ?? '';

    const shouldIncludeSuggestionRef = (ref: string): string | null => {
      const split = splitSheetRef(ref);
      if (!split.sheet && activeSheet !== defaultSheet) return null;
      if (split.sheet && split.sheet !== activeSheet) return null;
      return split.value;
    };

    for (const suggestion of suggestions ?? []) {
      const ref = suggestion.kind === 'discriminator'
        ? suggestion.cellRef
        : (suggestion.field.cell ?? suggestion.field.range);
      if (!ref) continue;

      const bareRef = shouldIncludeSuggestionRef(ref);
      if (!bareRef) continue;

      const parsed = parseRange(bareRef);
      if (!parsed) continue;

      const startCol = Math.min(parsed.start.col, parsed.end.col);
      const endCol = Math.max(parsed.start.col, parsed.end.col);
      const startRow = Math.min(parsed.start.row, parsed.end.row);
      const endRow = parsed.openEnded
        ? resolveOpenEndedEndRow(sheetData, {
            startRow,
            startCol,
            endCol,
            blankRows: suggestion.kind === 'discriminator' ? undefined : suggestion.field.blankRows,
          })
        : Math.max(parsed.start.row, parsed.end.row);

      if (endRow < startRow) continue;

      const label = suggestion.kind === 'discriminator'
        ? `Suggestion: discriminator ${suggestion.discriminatorValue}`
        : `Suggestion: ${suggestion.field.name}`;

      const baseRegion: SuggestionRegion = {
        suggestionId: suggestion.id,
        label,
        start: { col: startCol, row: startRow },
        end: { col: endCol, row: endRow },
      };
      const region = suggestion.id === activeSuggestionId && suggestionPreviewSelection
        ? (() => {
            const preview = normalizeRange(suggestionPreviewSelection.start, suggestionPreviewSelection.end);
            return {
              ...baseRegion,
              start: {
                col: renderedColSet.has(preview.start.col) ? preview.start.col : baseRegion.start.col,
                row: preview.start.row,
              },
              end: {
                col: renderedColSet.has(preview.end.col) ? preview.end.col : baseRegion.end.col,
                row: preview.end.row,
              },
            };
          })()
        : baseRegion;
      regions.push(region);

      for (let row = Math.max(region.start.row, gridWindow.firstRow); row <= Math.min(region.end.row, gridWindow.lastRow); row += 1) {
        for (let col = region.start.col; col <= region.end.col; col += 1) {
          if (!renderedColSet.has(col)) continue;
          cells.set(`${colIndexToLetter(col)}${row + 1}`, region);
        }
      }
    }

    return { cells, regions };
  }, [activeSheet, activeSuggestionId, renderedColSet, sheetData, sheetNames, suggestionPreviewSelection, suggestions, gridWindow.firstRow, gridWindow.lastRow]);

  const activeSuggestionRegion = useMemo(
    () => suggestionCells.regions.find((region) => region.suggestionId === activeSuggestionId),
    [activeSuggestionId, suggestionCells.regions],
  );

  const isDiscriminator = useCallback(
    (col: number, row: number) => {
      const ref = `${colIndexToLetter(col)}${row + 1}`;
      const defaultSheet = sheetNames[0] ?? '';

      return (discriminatorCells ?? []).some((cellRef) => {
        const split = splitSheetRef(cellRef);
        if (split.sheet) {
          return split.sheet === activeSheet && split.value === ref;
        }
        return activeSheet === defaultSheet && split.value === ref;
      });
    },
    [activeSheet, discriminatorCells, sheetNames],
  );

  /** The field mapped anywhere in a column, for the header label. */
  const columnFieldNames = useMemo(() => {
    const names = new Map<number, string>();
    for (const region of mappedFieldCells.regions) {
      for (let col = region.start.col; col <= region.end.col; col += 1) {
        if (!names.has(col)) names.set(col, region.fieldName);
      }
    }
    return names;
  }, [mappedFieldCells.regions]);

  /** Columns and rows covered by the selection, for header highlighting. */
  const selectedCols = useMemo(() => {
    if (!normalizedSelection) return null;
    return { first: normalizedSelection.start.col, last: normalizedSelection.end.col };
  }, [normalizedSelection]);

  const selectedRows = useMemo(() => {
    if (!normalizedSelection) return null;
    return { first: normalizedSelection.start.row, last: normalizedSelection.end.row };
  }, [normalizedSelection]);

  const getFieldForCell = useCallback(
    (col: number, row: number) => {
      const ref = `${colIndexToLetter(col)}${row + 1}`;
      return mappedFieldCells.cells.get(ref);
    },
    [mappedFieldCells.cells],
  );

  const getSuggestionForCell = useCallback(
    (col: number, row: number): SuggestionRegion | undefined => {
      const ref = `${colIndexToLetter(col)}${row + 1}`;
      return suggestionCells.cells.get(ref);
    },
    [suggestionCells.cells],
  );

  const mergeAt = useCallback((cell: CellAddress) => sheetData.cells[cell.row]?.[cell.col]?.merge, [sheetData.cells]);

  /** Merged cells behave like Excel: selecting one selects the whole region. */
  const expandToMerge = useCallback((cell: CellAddress): Selection => {
    const merge = mergeAt(cell);
    if (!merge) return { start: cell, end: cell };
    return {
      start: { col: merge.left, row: merge.top },
      end: { col: merge.right, row: merge.bottom },
    };
  }, [mergeAt]);

  /** Bottom-right of the merged region a cell belongs to (or the cell itself). */
  const snapToMergeEnd = useCallback((cell: CellAddress): CellAddress => {
    const merge = mergeAt(cell);
    return merge ? { col: merge.right, row: merge.bottom } : cell;
  }, [mergeAt]);

  // Resolve a cell address from a mouse event by peeking through the overlays.
  const resolveCellFromPoint = useCallback((clientX: number, clientY: number): CellAddress | null => {
    const overlays = overlayContainerRef.current;
    const previousVisibility = overlays?.style.visibility;
    if (overlays) overlays.style.visibility = 'hidden';
    try {
      const el = document.elementFromPoint(clientX, clientY);
      const td = el?.closest('[data-cell-ref]') as HTMLElement | null;
      const ref = td?.dataset.cellRef;
      if (!ref) return null;
      const match = ref.match(/^([A-Z]+)(\d+)$/);
      if (!match) return null;
      return { col: letterToColIndex(match[1]), row: parseInt(match[2], 10) - 1 };
    } finally {
      if (overlays) overlays.style.visibility = previousVisibility ?? '';
    }
  }, []);

  const beginGesture = useCallback((state: GestureState) => {
    gestureRef.current = state;
    lastCellRef.current = state.originCell;
    latestPointerRef.current = state.pointerStart;
    setGesture({ kind: state.kind, fieldName: state.fieldName, suggestionId: state.suggestionId });
  }, []);

  const endGesture = useCallback(() => {
    gestureRef.current = null;
    lastCellRef.current = null;
    cancelAnimationFrame(rafIdRef.current);
    cancelAnimationFrame(autoScrollRafRef.current);
    setGesture(null);
  }, []);

  // Keep the latest callbacks reachable from the window listeners without
  // re-installing them on every render.
  const onSetSelectionRef = useRef(onSetSelection);
  const onEndSelectionRef = useRef(onEndSelection);
  useEffect(() => {
    onSetSelectionRef.current = onSetSelection;
    onEndSelectionRef.current = onEndSelection;
  }, [onEndSelection, onSetSelection]);

  const handleCellMouseDown = useCallback(
    (col: number, row: number, event: React.MouseEvent<HTMLTableCellElement>) => {
      if (event.button !== 0) return;
      // Keep keyboard navigation working right after a click without letting the
      // browser scroll the grid to the clicked cell.
      tableRef.current?.focus({ preventScroll: true });
      const cell = { col, row };
      const fieldName = getFieldForCell(col, row);
      if (fieldName) onSelectField(fieldName);

      const merge = mergeAt(cell);
      beginGesture({
        kind: 'select',
        pointerStart: { x: event.clientX, y: event.clientY },
        originCell: merge ? { col: merge.left, row: merge.top } : cell,
        crossedThreshold: false,
        suggestionId: getSuggestionForCell(col, row)?.suggestionId,
      });
      onSetSelection(expandToMerge(cell));
    },
    [beginGesture, expandToMerge, getFieldForCell, getSuggestionForCell, mergeAt, onSelectField, onSetSelection],
  );

  /**
   * Drag the selection's corner handle to grow or shrink the range. This stays
   * inside the view: ending a normal selection gesture would open the field
   * dialog, which is not what resizing a selection means.
   */
  const handleSelectionHandleMouseDown = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      if (event.button !== 0 || !normalizedSelection) return;
      event.preventDefault();
      event.stopPropagation();
      tableRef.current?.focus({ preventScroll: true });

      const anchor = normalizedSelection.start;
      const resolve = (clientX: number, clientY: number) => {
        const cell = resolveCellFromPoint(clientX, clientY);
        return cell ? normalizeRange(anchor, cell) : null;
      };

      const onMove = (moveEvent: MouseEvent) => {
        const next = resolve(moveEvent.clientX, moveEvent.clientY);
        if (next) onSetSelection(next);
      };
      const onUp = (upEvent: MouseEvent) => {
        const next = resolve(upEvent.clientX, upEvent.clientY);
        if (next) onSetSelection(next);
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [normalizedSelection, onSetSelection, resolveCellFromPoint],
  );

  const handleCellMouseEnter = useCallback((col: number, row: number) => {
    const fieldName = getFieldForCell(col, row) ?? null;
    setHoveredFieldName((current) => (current === fieldName ? current : fieldName));
  }, [getFieldForCell]);

  const handleMoveGripMouseDown = useCallback(
    (region: FieldRegion, event: React.MouseEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const cell = resolveCellFromPoint(event.clientX, event.clientY) ?? region.start;
      onSelectField(region.fieldName);
      beginGesture({
        kind: 'move-field',
        pointerStart: { x: event.clientX, y: event.clientY },
        originCell: cell,
        crossedThreshold: false,
        fieldName: region.fieldName,
        sourceRange: { start: region.start, end: region.end },
      });
      onSetSelection({ start: region.start, end: region.end });
    },
    [beginGesture, onSelectField, onSetSelection, resolveCellFromPoint],
  );

  const handleResizeHandleMouseDown = useCallback(
    (region: FieldRegion, handle: ResizeHandle, event: React.MouseEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const anchor = resizeAnchor(handle, region);
      const dragged = handleCornerCell(handle, region);
      onSelectField(region.fieldName);
      beginGesture({
        kind: 'resize-field',
        pointerStart: { x: event.clientX, y: event.clientY },
        originCell: dragged,
        crossedThreshold: true,
        fieldName: region.fieldName,
        sourceRange: { start: region.start, end: region.end },
        handle,
        anchor,
      });
      onSetSelection(normalizeRange(anchor, dragged));
    },
    [beginGesture, onSelectField, onSetSelection],
  );

  const handleSuggestionResizeHandleMouseDown = useCallback(
    (region: SuggestionRegion, handle: ResizeHandle, event: React.MouseEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const anchor = resizeAnchor(handle, region);
      const dragged = handleCornerCell(handle, region);
      beginGesture({
        kind: 'resize-suggestion',
        pointerStart: { x: event.clientX, y: event.clientY },
        originCell: dragged,
        crossedThreshold: true,
        suggestionId: region.suggestionId,
        sourceRange: { start: region.start, end: region.end },
        handle,
        anchor,
      });
      onSetSelection(normalizeRange(anchor, dragged));
    },
    [beginGesture, onSetSelection],
  );

  // --- Viewport tracking -----------------------------------------------------

  // Overlay geometry is arithmetic, so it must agree with what the browser
  // actually laid out: measure the rendered header and data rows once.
  useLayoutEffect(() => {
    const container = tableRef.current;
    if (!container) return;
    const header = container.querySelector('thead');
    const rows = container.querySelectorAll<HTMLTableRowElement>('tbody tr[data-row-index]');
    if (!header || rows.length === 0) return;

    const rowHeight = Math.min(...Array.from(rows, (row) => row.offsetHeight));
    const headerHeight = header.offsetHeight;
    if (!rowHeight || !headerHeight) return;

    setMetrics((current) => (
      current
      && current.sheet === activeSheet
      && current.rowHeight === rowHeight
      && current.headerHeight === headerHeight
        ? current
        : { sheet: activeSheet, rowHeight, headerHeight }
    ));
  }, [activeSheet, geometry, sheetData]);

  useEffect(() => {
    const container = tableRef.current;
    if (!container) return;

    const sync = () => {
      setViewport((current) => {
        const next = {
          scrollTop: container.scrollTop,
          scrollLeft: container.scrollLeft,
          width: container.clientWidth,
          height: container.clientHeight,
        };
        if (
          current.scrollTop === next.scrollTop
          && current.scrollLeft === next.scrollLeft
          && current.width === next.width
          && current.height === next.height
        ) {
          return current;
        }
        return next;
      });
    };

    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(container);
    return () => observer.disconnect();
  }, [activeSheet]);

  // Each sheet starts at the top-left of the grid.
  useEffect(() => {
    const container = tableRef.current;
    if (!container) return;
    container.scrollTop = 0;
    container.scrollLeft = 0;
    setViewport((current) => (
      current.scrollTop === 0 && current.scrollLeft === 0
        ? current
        : { ...current, scrollTop: 0, scrollLeft: 0 }
    ));
  }, [activeSheet]);

  const handleScroll = useCallback(() => {
    const container = tableRef.current;
    if (!container) return;
    cancelAnimationFrame(rafIdRef.current);
    rafIdRef.current = requestAnimationFrame(() => {
      setViewport((current) => {
        const next = {
          scrollTop: container.scrollTop,
          scrollLeft: container.scrollLeft,
          width: container.clientWidth,
          height: container.clientHeight,
        };
        if (
          current.scrollTop === next.scrollTop
          && current.scrollLeft === next.scrollLeft
          && current.width === next.width
          && current.height === next.height
        ) {
          return current;
        }
        return next;
      });
    });
  }, []);

  // --- Gesture handling ------------------------------------------------------

  const applyGestureAtPointer = useCallback(() => {
    const state = gestureRef.current;
    if (!state) return;
    const { x, y } = latestPointerRef.current;
    const point = gesturePoint(state, x, y);
    const cell = resolveCellFromPoint(point.x, point.y);
    if (!cell) return;
    lastCellRef.current = cell;
    const next = resolveGestureSelection(state, cell, boundsRef.current);
    if (!next) return;
    // Growing a selection over a merged cell includes the whole merged region.
    onSetSelectionRef.current(
      state.kind === 'select' ? { start: next.start, end: snapToMergeEnd(next.end) } : next,
    );
  }, [resolveCellFromPoint, snapToMergeEnd]);

  const runEdgeAutoScroll = useCallback(() => {
    const container = tableRef.current;
    const state = gestureRef.current;
    if (!container || !state) return;

    const { x, y } = latestPointerRef.current;
    const rect = container.getBoundingClientRect();
    let dx = 0;
    let dy = 0;

    if (x < rect.left + EDGE_SCROLL_PX) {
      dx = -Math.min(MAX_EDGE_SCROLL_STEP, (rect.left + EDGE_SCROLL_PX - x) / 2);
    } else if (x > rect.right - EDGE_SCROLL_PX) {
      dx = Math.min(MAX_EDGE_SCROLL_STEP, (x - (rect.right - EDGE_SCROLL_PX)) / 2);
    }
    if (y < rect.top + EDGE_SCROLL_PX) {
      dy = -Math.min(MAX_EDGE_SCROLL_STEP, (rect.top + EDGE_SCROLL_PX - y) / 2);
    } else if (y > rect.bottom - EDGE_SCROLL_PX) {
      dy = Math.min(MAX_EDGE_SCROLL_STEP, (y - (rect.bottom - EDGE_SCROLL_PX)) / 2);
    }

    if (!dx && !dy) return;

    const previousLeft = container.scrollLeft;
    const previousTop = container.scrollTop;
    container.scrollLeft += dx;
    container.scrollTop += dy;
    const scrolled = container.scrollLeft !== previousLeft || container.scrollTop !== previousTop;

    if (scrolled) {
      applyGestureAtPointer();
      autoScrollRafRef.current = requestAnimationFrame(runEdgeAutoScroll);
    }
  }, [applyGestureAtPointer]);

  // Single window-level gesture controller: one code path for every drag, whether
  // it started on a cell, a field overlay or a resize handle, and whether the
  // pointer is still inside the grid or not.
  useEffect(() => {
    const onWindowMouseMove = (event: MouseEvent) => {
      const state = gestureRef.current;
      if (!state) return;

      latestPointerRef.current = { x: event.clientX, y: event.clientY };

      if (!state.crossedThreshold && exceededDragThreshold(state.pointerStart, event)) {
        state.crossedThreshold = true;
      }

      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = requestAnimationFrame(() => {
        applyGestureAtPointer();
      });

      // Dragging past the edge of the grid keeps scrolling.
      cancelAnimationFrame(autoScrollRafRef.current);
      autoScrollRafRef.current = requestAnimationFrame(runEdgeAutoScroll);
    };

    const onWindowMouseUp = (event: MouseEvent) => {
      const state = gestureRef.current;
      if (!state) return;
      cancelAnimationFrame(rafIdRef.current);
      cancelAnimationFrame(autoScrollRafRef.current);

      latestPointerRef.current = { x: event.clientX, y: event.clientY };
      const point = gesturePoint(state, event.clientX, event.clientY);
      const cellAtRelease = resolveCellFromPoint(point.x, point.y)
        ?? lastCellRef.current
        ?? state.originCell;
      const selection = resolveGestureSelection(state, cellAtRelease, boundsRef.current)
        ?? { start: state.originCell, end: state.originCell };
      const crossed = state.crossedThreshold || exceededDragThreshold(state.pointerStart, event);

      let result: GestureResult;
      if (!crossed && state.kind === 'move-field' && state.fieldName) {
        result = { kind: 'select-field', fieldName: state.fieldName, selection };
      } else if (!crossed && state.kind === 'select' && state.suggestionId) {
        result = { kind: 'select-suggestion', suggestionId: state.suggestionId, selection };
      } else if (!crossed && state.kind === 'select') {
        result = { kind: 'select', selection: expandToMerge(cellAtRelease) };
      } else if (state.kind === 'move-field' && state.fieldName) {
        result = {
          kind: 'move-field',
          fieldName: state.fieldName,
          selection,
          sourceRange: state.sourceRange,
          moved: state.sourceRange ? !selectionsEqual(selection, state.sourceRange) : true,
        };
      } else if (state.kind === 'resize-field' && state.fieldName) {
        result = {
          kind: 'resize-field',
          fieldName: state.fieldName,
          selection,
          sourceRange: state.sourceRange,
        };
      } else if (state.kind === 'resize-suggestion' && state.suggestionId) {
        result = {
          kind: 'resize-suggestion',
          suggestionId: state.suggestionId,
          selection,
        };
      } else {
        result = {
          kind: 'select',
          selection: { start: selection.start, end: snapToMergeEnd(selection.end) },
        };
      }

      endGesture();
      onEndSelectionRef.current(result);
    };

    const onWindowBlur = () => {
      if (gestureRef.current) endGesture();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && gestureRef.current) endGesture();
    };

    window.addEventListener('mousemove', onWindowMouseMove);
    window.addEventListener('mouseup', onWindowMouseUp);
    window.addEventListener('blur', onWindowBlur);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      cancelAnimationFrame(rafIdRef.current);
      cancelAnimationFrame(autoScrollRafRef.current);
      window.removeEventListener('mousemove', onWindowMouseMove);
      window.removeEventListener('mouseup', onWindowMouseUp);
      window.removeEventListener('blur', onWindowBlur);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [applyGestureAtPointer, endGesture, expandToMerge, resolveCellFromPoint, runEdgeAutoScroll, snapToMergeEnd]);

  // --- Scrolling helpers -----------------------------------------------------

  /** Scroll the minimum amount needed to bring a cell fully into view. */
  const scrollCellIntoView = useCallback((cell: CellAddress) => {
    const container = tableRef.current;
    if (!container) return;
    const rect = cellRect(geometry, cell.col, cell.row);
    const insets = { top: geometry.headerHeight, left: geometry.gutterWidth };
    const viewTop = container.scrollTop;
    const viewLeft = container.scrollLeft;
    let nextTop = viewTop;
    let nextLeft = viewLeft;

    if (rect.top < viewTop + insets.top) {
      nextTop = rect.top - insets.top;
    } else if (rect.top + rect.height > viewTop + container.clientHeight) {
      nextTop = rect.top + rect.height - container.clientHeight;
    }
    if (rect.left < viewLeft + insets.left) {
      nextLeft = rect.left - insets.left;
    } else if (rect.left + rect.width > viewLeft + container.clientWidth) {
      nextLeft = rect.left + rect.width - container.clientWidth;
    }

    if (nextTop !== viewTop || nextLeft !== viewLeft) {
      container.scrollTo({ top: Math.max(0, nextTop), left: Math.max(0, nextLeft) });
    }
  }, [geometry]);

  // --- Find in sheet ---------------------------------------------------------

  const findResults = useMemo(
    () => (findOpen ? findMatches(sheetData, findQuery, { matchCase: findMatchCase }) : []),
    [findOpen, sheetData, findQuery, findMatchCase],
  );
  const findIndexInRange = findResults.length
    ? Math.min(findIndex, findResults.length - 1)
    : 0;
  const currentFindMatch = findResults[findIndexInRange] ?? null;

  const revealFindMatch = useCallback((match: { col: number; row: number }) => {
    onSetSelectionRef.current({
      start: { col: match.col, row: match.row },
      end: { col: match.col, row: match.row },
    });
    scrollCellIntoView({ col: match.col, row: match.row });
  }, [scrollCellIntoView]);

  const goToFindMatch = useCallback(
    (direction: 1 | -1) => {
      if (!findResults.length) return;
      const next = stepMatchIndex(findIndexInRange, findResults.length, direction);
      setFindIndex(next);
      const match = findResults[next];
      if (match) revealFindMatch(match);
    },
    [findIndexInRange, findResults, revealFindMatch],
  );

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindQuery('');
    setFindIndex(0);
    tableRef.current?.focus();
  }, []);

  // Jump to the first match when the query, the options or the sheet change.
  const findSignature = `${activeSheet}\u0000${findMatchCase}\u0000${findQuery}`;
  const lastFindSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    if (!findOpen) {
      lastFindSignatureRef.current = null;
      return;
    }
    if (lastFindSignatureRef.current === findSignature) return;
    lastFindSignatureRef.current = findSignature;
    setFindIndex(0);
    const first = findResults[0];
    if (first) revealFindMatch(first);
  }, [findOpen, findSignature, findResults, revealFindMatch]);

  // Ctrl/Cmd+F opens the find bar; text fields keep their own find.
  useEffect(() => {
    const onFindKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'f') return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;
      event.preventDefault();
      setFindOpen(true);
      requestAnimationFrame(() => {
        findInputRef.current?.focus();
        findInputRef.current?.select();
      });
    };

    window.addEventListener('keydown', onFindKeyDown);
    return () => window.removeEventListener('keydown', onFindKeyDown);
  }, []);

  const handleFindInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        goToFindMatch(event.shiftKey ? -1 : 1);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        closeFind();
      }
    },
    [closeFind, goToFindMatch],
  );

  // Reveal programmatic selections (field list clicks, suggestion focus) without
  // fighting the user's scroll during a drag.
  const lastRevealTokenRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (revealToken === undefined || lastRevealTokenRef.current === revealToken) return;
    lastRevealTokenRef.current = revealToken;
    const container = tableRef.current;
    if (!normalizedSelection || !container) return;

    const startRect = cellRect(geometry, normalizedSelection.start.col, normalizedSelection.start.row);
    const endRect = cellRect(geometry, normalizedSelection.end.col, normalizedSelection.end.row);

    container.scrollTo({
      left: Math.max(0, (startRect.left + endRect.left + endRect.width) / 2 - container.clientWidth / 2),
      top: Math.max(0, (startRect.top + endRect.top + endRect.height) / 2 - container.clientHeight / 2),
      behavior: 'smooth',
    });
  }, [geometry, normalizedSelection, revealToken]);

  // Return focus to the grid when the app asks for it (e.g. after the field
  // dialog closes) so arrow-key navigation keeps working.
  const lastFocusTokenRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (focusToken === undefined || lastFocusTokenRef.current === focusToken) return;
    lastFocusTokenRef.current = focusToken;
    tableRef.current?.focus({ preventScroll: true });
  }, [focusToken]);

  const startColumnResize = useCallback(
    (event: React.MouseEvent, col: number) => {
      event.preventDefault();
      event.stopPropagation();

      const startX = event.clientX;
      const startWidth = geometry.colWidths[col] || 120;

      const handleMove = (moveEvent: MouseEvent) => {
        const next = clampColWidth(startWidth + (moveEvent.clientX - startX));
        setColWidthOverrides((prev) => ({
          ...prev,
          [activeSheet]: { ...(prev[activeSheet] ?? {}), [col]: next },
        }));
      };
      const handleUp = () => {
        document.removeEventListener('mousemove', handleMove);
        document.removeEventListener('mouseup', handleUp);
      };

      document.addEventListener('mousemove', handleMove);
      document.addEventListener('mouseup', handleUp);
    },
    [activeSheet, geometry.colWidths],
  );

  const resetColumnWidth = useCallback((col: number) => {
    setColWidthOverrides((prev) => {
      const sheetOverrides = { ...(prev[activeSheet] ?? {}) };
      delete sheetOverrides[col];
      return { ...prev, [activeSheet]: sheetOverrides };
    });
  }, [activeSheet]);

  const handleGridKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (findOpen && event.key === 'Escape') {
        event.preventDefault();
        closeFind();
        return;
      }

      const activeBounds = boundsRef.current;
      const anchor = selection?.start ?? null;
      const active = selection?.end ?? null;

      const step = (dc: number, dr: number): Selection => {
        // With nothing selected, start at the top-left of the grid.
        if (!active) {
          return expandToMerge(clampCell({ col: 0, row: 0 }, activeBounds));
        }
        const next = clampCell({ col: active.col + dc, row: active.row + dr }, activeBounds);
        if (event.shiftKey && anchor) {
          return { start: anchor, end: snapToMergeEnd(next) };
        }
        return expandToMerge(next);
      };

      const wantsCopy = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c';
      if (wantsCopy) {
        if (!normalizedSelection) return;
        event.preventDefault();
        const text = selectionToTsv(sheetData, normalizedSelection.start, normalizedSelection.end);
        if (text && navigator.clipboard) {
          void navigator.clipboard.writeText(text);
        }
        return;
      }

      switch (event.key) {
        case 'ArrowLeft':
        case 'ArrowRight':
        case 'ArrowUp':
        case 'ArrowDown': {
          event.preventDefault();
          const dc = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
          const dr = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
          const next = step(dc, dr);
          onSetSelection(next);
          scrollCellIntoView(next.end);
          return;
        }
        case 'Enter': {
          if (!normalizedSelection) return;
          event.preventDefault();
          onEndSelection({ kind: 'select', selection: normalizedSelection });
          return;
        }
        case 'Escape': {
          if (!selection) return;
          event.preventDefault();
          onClearSelection();
          return;
        }
        case 'Delete':
        case 'Backspace': {
          const cell = normalizedSelection?.start ?? active;
          if (!cell) return;
          const fieldName = getFieldForCell(cell.col, cell.row);
          if (!fieldName) return;
          event.preventDefault();
          onDeleteField(fieldName);
          return;
        }
        default:
          return;
      }
    },
    [
      closeFind,
      findOpen,
      getFieldForCell,
      normalizedSelection,
      onClearSelection,
      sheetData,
      onDeleteField,
      onEndSelection,
      expandToMerge,
      onSetSelection,
      snapToMergeEnd,
      scrollCellIntoView,
      selection,
    ],
  );

  // --- Region overlays (pure geometry, so they stay correct off-screen) ------

  interface OverlayRect {
    key: string;
    top: number;
    left: number;
    width: number;
    height: number;
    region: FieldRegion;
  }

  const overlayRects = useMemo<OverlayRect[]>(
    () => mappedFieldCells.regions.map((region) => ({
      key: region.fieldName,
      region,
      ...cellRect(geometry, region.start.col, region.start.row, region.end.col, region.end.row),
    })),
    [geometry, mappedFieldCells.regions],
  );

  const findHighlightRects = useMemo(() => {
    if (!findOpen || !findQuery) return [];
    const currentKey = currentFindMatch ? findMatchKey(currentFindMatch) : null;
    return findResults
      .filter(
        (match) =>
          match.row >= gridWindow.firstRow &&
          match.row <= gridWindow.lastRow &&
          match.col >= gridWindow.firstCol &&
          match.col <= gridWindow.lastCol,
      )
      .map((match) => {
        const key = findMatchKey(match);
        return {
          key,
          isCurrent: key === currentKey,
          ...cellRect(geometry, match.col, match.row),
        };
      });
  }, [currentFindMatch, findOpen, findQuery, findResults, geometry, gridWindow]);

  const activeSuggestionRect = useMemo(() => {
    if (!activeSuggestionRegion) return null;
    return {
      region: activeSuggestionRegion,
      ...cellRect(
        geometry,
        activeSuggestionRegion.start.col,
        activeSuggestionRegion.start.row,
        activeSuggestionRegion.end.col,
        activeSuggestionRegion.end.row,
      ),
    };
  }, [activeSuggestionRegion, geometry]);

  const movePreviewRect = useMemo(() => {
    if (gesture?.kind !== 'move-field' || !gesture.fieldName || !normalizedSelection) return null;
    const preview = normalizeRange(normalizedSelection.start, normalizedSelection.end);
    return {
      ...cellRect(geometry, preview.start.col, preview.start.row, preview.end.col, preview.end.row),
      start: preview.start,
      end: preview.end,
      fieldName: gesture.fieldName,
    };
  }, [geometry, gesture, normalizedSelection]);

  const edgeBandClass = 'absolute pointer-events-auto bg-transparent';
  const cellMergeExtent = useCallback((col: number, row: number) => {
    const merge = sheetData.cells[row]?.[col]?.merge;
    if (!merge) return { rowSpan: 1, colSpan: 1, visible: true };
    if (!isMergeStart(merge, gridWindow, col, row)) {
      return { rowSpan: 1, colSpan: 1, visible: false };
    }
    return mergeExtent(merge, gridWindow);
  }, [gridWindow, sheetData.cells]);

  const activeCell = normalizedSelection?.start ?? null;
  const activeCellStyle = activeCell ? sheetData.cells[activeCell.row]?.[activeCell.col]?.style : undefined;
  const activeCellLabel = activeCell
    ? `${colIndexToLetter(activeCell.col)}${activeCell.row + 1}`
    : '';
  // The box shows the selection until the reader types their own reference.
  const [cellRefDraft, setCellRefDraft] = useState<string | null>(null);
  const cellRefValue = cellRefDraft ?? activeCellLabel;

  const jumpToCellRef = useCallback((raw: string) => {
    const match = raw.trim().toUpperCase().match(/^([A-Z]{1,3})(\d{1,7})$/);
    if (!match) return;
    const col = letterToColIndex(match[1]);
    const row = Number(match[2]) - 1;
    const bounds = boundsRef.current;
    if (col < 0 || row < 0 || col > bounds.maxCol || row > bounds.maxRow) return;
    onSetSelection({ start: { col, row }, end: { col, row } });
    scrollCellIntoView({ col, row });
    tableRef.current?.focus({ preventScroll: true });
  }, [onSetSelection, scrollCellIntoView]);

  const findStatus = !findQuery
    ? ''
    : findResults.length === 0
      ? 'No matches'
      : `${findIndexInRange + 1} of ${findResults.length}`;

  return (
    <div className="relative flex flex-col h-full">
      {/* Floating so opening it never shifts the grid or the sidebars. */}
      {findOpen && (
        <div className="absolute right-3 top-9 z-30 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-elevated/95 px-2.5 py-1.5 shadow-lg backdrop-blur">
          <input
            ref={findInputRef}
            type="text"
            value={findQuery}
            onChange={(event) => setFindQuery(event.target.value)}
            onKeyDown={handleFindInputKeyDown}
            placeholder="Find in sheet"
            aria-label="Find in sheet"
            className="h-7 w-44 rounded border border-border bg-surface px-2 text-xs text-text placeholder:text-text-faint outline-none focus:border-accent"
          />
          <span className="min-w-[56px] text-[11px] text-text-muted">{findStatus}</span>
          <button
            type="button"
            onClick={() => goToFindMatch(-1)}
            disabled={findResults.length === 0}
            title="Previous match (Shift+Enter)"
            aria-label="Previous match"
            className="flex h-7 w-7 items-center justify-center rounded border border-border bg-surface text-text-secondary hover:text-text disabled:opacity-40"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => goToFindMatch(1)}
            disabled={findResults.length === 0}
            title="Next match (Enter)"
            aria-label="Next match"
            className="flex h-7 w-7 items-center justify-center rounded border border-border bg-surface text-text-secondary hover:text-text disabled:opacity-40"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          <label
            className="inline-flex items-center gap-1 text-[11px] text-text-secondary"
            title="Match case"
          >
            <Checkbox
              checked={findMatchCase}
              onCheckedChange={(checked) => setFindMatchCase(Boolean(checked))}
            />
            Aa
          </label>
          <button
            type="button"
            onClick={closeFind}
            title="Close find (Escape)"
            aria-label="Close find"
            className="flex h-7 w-7 items-center justify-center rounded border border-border bg-surface text-text-secondary hover:text-text"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Sheet card: format strip plus the grid, like a spreadsheet surface. */}
      <div className="relative m-2 flex min-h-0 flex-1 flex-col overflow-hidden rounded-[13px] border border-border-strong bg-cell shadow-[0_12px_35px_rgb(0_0_0/7%)] dark:shadow-[0_14px_36px_rgb(0_0_0/28%)]">
      <div className="flex shrink-0 items-center gap-1 border-b border-border bg-surface px-2 py-1">
        <input
          value={cellRefValue}
          onChange={(event) => setCellRefDraft(event.target.value)}
          onBlur={() => setCellRefDraft(null)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setCellRefDraft(null);
              return;
            }
            if (event.key !== 'Enter') return;
            event.preventDefault();
            jumpToCellRef(cellRefValue);
            setCellRefDraft(null);
          }}
          aria-label="Active cell reference"
          title="Type a reference and press Enter to jump to it"
          className="h-6 w-20 rounded border border-border bg-canvas px-2 font-mono text-[11px] text-text outline-none focus:border-accent"
        />

        <div className="mx-1 h-4 w-px bg-border" />

        <button
          type="button"
          onClick={onDefineField}
          disabled={!normalizedSelection}
          title="Map the selected cells to a field"
          className="flex h-6 items-center gap-1.5 rounded bg-primary px-2.5 text-[11px] font-medium text-primary-foreground hover:bg-accent-hover disabled:opacity-40"
        >
          <svg className="size-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          Define field
        </button>

        {activeCellStyle?.numFmt && (
          <span
            className="inline-flex h-6 items-center rounded border border-border px-2 font-mono text-[11px] text-text-muted"
            title="Number format from the workbook"
          >
            {activeCellStyle.numFmt}
          </span>
        )}

        <button
          type="button"
          onClick={onClearSelection}
          disabled={!normalizedSelection}
          className="h-6 rounded px-2 text-[11px] text-text-secondary hover:bg-elevated hover:text-text disabled:opacity-40"
        >
          Clear
        </button>

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setFindOpen(true)}
            title="Find in sheet (Ctrl+F)"
            className="flex h-6 items-center gap-1 rounded px-2 text-[11px] text-text-secondary hover:bg-elevated hover:text-text"
          >
            <svg className="size-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 10.5a6.5 6.5 0 11-13 0 6.5 6.5 0 0113 0z" />
            </svg>
            Find
          </button>
        </div>
      </div>

      <div
        ref={tableRef}
        className="flex-1 overflow-auto relative bg-cell outline-none"
        tabIndex={0}
        onKeyDown={handleGridKeyDown}
        onScroll={handleScroll}
        role="grid"
        aria-label={`Spreadsheet ${activeSheet}`}
        aria-rowcount={geometry.rows}
        aria-colcount={geometry.cols}
      >
        <table
          className="border-collapse text-xs select-none"
          style={{
            tableLayout: 'fixed',
            width: geometry.totalWidth + fillerWidths.reduce((sum, width) => sum + width, 0),
          }}
        >
          <colgroup>
            <col style={{ width: geometry.gutterWidth }} />
            {geometry.colWidths.map((width, col) => (
              <col key={col} style={{ width }} />
            ))}
            {fillerWidths.map((width, offset) => (
              <col key={`filler-${offset}`} style={{ width }} />
            ))}
          </colgroup>
          <thead className="sticky top-0 z-10">
            <tr style={{ height: geometry.headerHeight }}>
              <th className="sticky left-0 z-20 border border-border bg-header text-header-text" />
              {gridWindow.firstCol > 0 && <th colSpan={gridWindow.firstCol} className="bg-header" />}
              {Array.from({ length: Math.max(0, gridWindow.lastCol - gridWindow.firstCol + 1) }, (_, offset) => {
                const colIndex = gridWindow.firstCol + offset;
                if (geometry.colWidths[colIndex] === 0) {
                  // Hidden columns keep their slot so later cells stay aligned.
                  return <th key={colIndex} className="p-0" />;
                }
                return (
                  <th
                    key={colIndex}
                    className={`relative overflow-hidden border border-border px-[10px] py-1 text-[11px] font-medium ${
                      selectedCols && colIndex >= selectedCols.first && colIndex <= selectedCols.last
                        ? 'bg-header-strong text-header-text-strong'
                        : 'bg-header text-header-text'
                    }`}
                  >
                    <span className="flex items-baseline gap-1.5">
                      <span className="text-text-faint">{colIndexToLetter(colIndex)}</span>
                      {columnFieldNames.get(colIndex) && (
                        <span className="truncate">{columnFieldNames.get(colIndex)}</span>
                      )}
                    </span>
                    <div
                      role="separator"
                      aria-label={`Resize column ${colIndexToLetter(colIndex)}`}
                      title="Drag to resize, double-click to reset"
                      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-accent/60"
                      onMouseDown={(event) => startColumnResize(event, colIndex)}
                      onDoubleClick={() => resetColumnWidth(colIndex)}
                    />
                  </th>
                );
              })}
              {gridWindow.lastCol < geometry.cols - 1 && (
                <th colSpan={geometry.cols - 1 - gridWindow.lastCol} className="bg-header" />
              )}
              {Array.from({ length: fillerCols }, (_, offset) => (
                <th
                  key={`filler-header-${offset}`}
                  className="overflow-hidden border border-border bg-header px-[10px] py-1 text-[11px] font-medium text-header-text"
                >
                  {colIndexToLetter(geometry.cols + offset)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {gridWindow.firstRow > 0 && (
              <tr style={{ height: gridWindow.firstRow * geometry.rowHeight }} aria-hidden="true">
                <td colSpan={geometry.cols + fillerCols + 1} className="p-0" />
              </tr>
            )}
            {renderedRows.map((r) => (
              <tr key={r} data-row-index={r} style={{ height: geometry.rowHeight }}>
                <td
                  className={`sticky left-0 z-[5] border border-border py-1 pr-[10px] text-right font-mono text-[11px] tabular-nums ${
                    selectedRows && r >= selectedRows.first && r <= selectedRows.last
                      ? 'bg-header-strong text-header-text-strong'
                      : 'bg-header text-header-text'
                  }`}
                >
                  {r + 1}
                </td>
                {gridWindow.firstCol > 0 && (
                  <td colSpan={gridWindow.firstCol} className="p-0" aria-hidden="true" />
                )}
                {Array.from({ length: Math.max(0, gridWindow.lastCol - gridWindow.firstCol + 1) }, (_, offset) => {
                  const c = gridWindow.firstCol + offset;
                  const extent = cellMergeExtent(c, r);
                  if (!extent.visible) {
                    // Covered by a merge or a rowSpan emitted earlier in the table.
                    return null;
                  }
                  if (geometry.colWidths[c] === 0 && extent.colSpan === 1) {
                    // Hidden columns keep their slot so later cells stay aligned.
                    return <td key={c} className="p-0" />;
                  }
                  const isDisc = isDiscriminator(c, r);
                  const fieldName = getFieldForCell(c, r);
                  const suggestionRegion = getSuggestionForCell(c, r);
                  const isActiveSuggestion = suggestionRegion?.suggestionId === activeSuggestionId;
                  const cellInfo = sheetData.cells[r]?.[c];
                  const value = cellInfo?.value ?? null;
                  const cellStyle = cellInfo?.style;

                  let cellClass = 'px-[9px] py-1 text-xs whitespace-nowrap overflow-hidden cursor-cell ';

                  if (isDisc) {
                    cellClass += 'bg-amber-500/20 ';
                  } else if (fieldName) {
                    cellClass += 'bg-emerald-500/10 ';
                  } else if (isActiveSuggestion) {
                    cellClass += 'bg-orange-500/8 ';
                  } else if (suggestionRegion) {
                    cellClass += 'bg-orange-500/4 ';
                  } else {
                    cellClass += 'bg-cell hover:bg-cell-hover ';
                  }

                  if (isDisc) {
                    cellClass += 'border border-amber-500/50 ';
                  } else if (
                    !cellStyle?.borderTop && !cellStyle?.borderBottom &&
                    !cellStyle?.borderLeft && !cellStyle?.borderRight
                  ) {
                    cellClass += 'border border-cell-border ';
                  }

                  const display = formatCellDisplay(value);

                  return (
                    <td
                      key={c}
                      data-cell-ref={`${colIndexToLetter(c)}${r + 1}`}
                      className={`${cellClass} relative`}
                      style={styleToCSS(cellStyle)}
                      rowSpan={extent.rowSpan > 1 ? extent.rowSpan : undefined}
                      colSpan={extent.colSpan > 1 ? extent.colSpan : undefined}
                      onMouseDown={(event) => handleCellMouseDown(c, r, event)}
                      onMouseEnter={() => handleCellMouseEnter(c, r)}
                      title={
                        fieldName
                          ? `Field: ${fieldName}${display ? `\nValue: ${display}` : ''}`
                          : suggestionRegion
                            ? `${suggestionRegion.label}${display ? `\nValue: ${display}` : ''}`
                            : display || undefined
                      }
                    >
                      {display}
                    </td>
                  );
                })}
                {gridWindow.lastCol < geometry.cols - 1 && (
                  <td
                    colSpan={geometry.cols - 1 - gridWindow.lastCol}
                    className="p-0"
                    aria-hidden="true"
                  />
                )}
                {Array.from({ length: fillerCols }, (_, offset) => (
                  <td
                    key={`filler-cell-${offset}`}
                    className="border border-cell-border bg-cell"
                  />
                ))}
              </tr>
            ))}
            {gridWindow.lastRow < geometry.rows - 1 && (
              <tr
                style={{ height: (geometry.rows - 1 - gridWindow.lastRow) * geometry.rowHeight }}
                aria-hidden="true"
              >
                <td colSpan={geometry.cols + fillerCols + 1} className="p-0" />
              </tr>
            )}
            {Array.from({ length: fillerRows }, (_, offset) => {
              const rowIndex = geometry.rows + offset;
              return (
                <tr key={`filler-row-${offset}`} style={{ height: geometry.rowHeight }} aria-hidden="true">
                  <td className="sticky left-0 z-[5] border border-border bg-header py-1 pr-[10px] text-right font-mono text-[11px] tabular-nums text-header-text">
                    {rowIndex + 1}
                  </td>
                  {gridWindow.firstCol > 0 && (
                    <td colSpan={gridWindow.firstCol} className="p-0" aria-hidden="true" />
                  )}
                  {Array.from({ length: visibleColSpan }, (_, cellOffset) => {
                    const col = gridWindow.firstCol + cellOffset;
                    if (geometry.colWidths[col] === 0) {
                      return <td key={col} className="p-0" />;
                    }
                    return (
                      <td key={col} className="border border-cell-border bg-cell" />
                    );
                  })}
                  {gridWindow.lastCol < geometry.cols - 1 && (
                    <td
                      colSpan={geometry.cols - 1 - gridWindow.lastCol}
                      className="p-0"
                      aria-hidden="true"
                    />
                  )}
                  {Array.from({ length: fillerCols }, (_, colOffset) => (
                    <td key={`filler-cell-${colOffset}`} className="border border-cell-border bg-cell" />
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* Field region overlays — single continuous border per region */}
        <div ref={overlayContainerRef}>
        {findHighlightRects.map((rect) => (
          <div
            key={rect.key}
            className={
              rect.isCurrent
                ? 'absolute pointer-events-none border-2 border-amber-400 bg-amber-400/40'
                : 'absolute pointer-events-none border border-amber-500/70 bg-amber-400/20'
            }
            style={{
              top: rect.top,
              left: rect.left,
              width: rect.width,
              height: rect.height,
            }}
          />
        ))}
        {selectionRect && (
          <>
            <div
              className="pointer-events-none absolute border-2 border-selection"
              style={{
                top: selectionRect.top,
                left: selectionRect.left,
                width: selectionRect.width,
                height: selectionRect.height,
              }}
            />
            <div
              role="button"
              aria-label="Extend selection"
              title="Drag to extend the selection"
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                handleSelectionHandleMouseDown(event);
              }}
              className="absolute z-20 h-[7px] w-[7px] cursor-crosshair border border-white bg-selection"
              style={{
                top: selectionRect.top + selectionRect.height - 4,
                left: selectionRect.left + selectionRect.width - 4,
              }}
            />
          </>
        )}
        {overlayRects.map((rect) => {
          const isSingleCell = rect.region.start.col === rect.region.end.col
            && rect.region.start.row === rect.region.end.row;
          const isActiveField = rect.region.fieldName === activeFieldName;
          const isMovingField = gesture?.kind === 'move-field' && gesture.fieldName === rect.region.fieldName;
          const showMoveGrip = isActiveField || hoveredFieldName === rect.region.fieldName;

          return (
            <div
              key={rect.key}
              className="absolute pointer-events-none"
              style={{
                top: rect.top,
                left: rect.left,
                width: rect.width,
                height: rect.height,
              }}
            >
              {/* Solid continuous border */}
              <div
                className={`absolute inset-0 pointer-events-none ${isActiveField ? 'border-2 border-emerald-500' : 'border border-emerald-500/70'} ${isMovingField ? 'opacity-35' : ''}`}
                style={{
                  boxShadow: isActiveField
                    ? 'inset 0 0 0 1px rgba(255,255,255,0.22)'
                    : 'inset 0 0 0 1px rgba(16,185,129,0.10)',
                }}
              />

              {/* Tint only — cells inside a field stay selectable */}
              <div
                className={`absolute inset-0 pointer-events-none ${isActiveField ? 'bg-emerald-500/6' : 'bg-transparent'} ${isMovingField ? 'opacity-35' : ''}`}
              />

              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <button
                    type="button"
                    className={`absolute right-[3px] top-[3px] h-[15px] w-[18px] items-center justify-center rounded border border-emerald-500/60 bg-background/95 text-emerald-600 shadow-sm transition-opacity active:cursor-grabbing dark:text-emerald-300 ${showMoveGrip ? 'pointer-events-auto flex cursor-grab opacity-100' : 'pointer-events-none flex opacity-0'} ${isMovingField ? 'opacity-35' : ''}`}
                    onMouseDown={(event) => handleMoveGripMouseDown(rect.region, event)}
                    onDoubleClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onEditField(rect.region.fieldName);
                    }}
                    onContextMenu={(event) => {
                      event.stopPropagation();
                      onSelectField(rect.region.fieldName);
                    }}
                    title={`${rect.region.fieldName} — drag to move, double-click to edit`}
                    aria-label={`Move ${rect.region.fieldName}`}
                  >
                    <svg className="h-3 w-3" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
                      <circle cx="4" cy="3" r="1" />
                      <circle cx="8" cy="3" r="1" />
                      <circle cx="4" cy="6" r="1" />
                      <circle cx="8" cy="6" r="1" />
                      <circle cx="4" cy="9" r="1" />
                      <circle cx="8" cy="9" r="1" />
                    </svg>
                  </button>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-40">
                  <ContextMenuItem onSelect={() => onEditField(rect.region.fieldName)}>
                    Edit
                    <ContextMenuShortcut>Enter</ContextMenuShortcut>
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    variant="destructive"
                    onSelect={() => onDeleteField(rect.region.fieldName)}
                  >
                    Delete
                    <ContextMenuShortcut>Del</ContextMenuShortcut>
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>

              {!isSingleCell && (
                <>
                  <button
                    type="button"
                    className={`${edgeBandClass} -top-[4px] left-[6px] right-[6px] h-[8px]`}
                    style={{ cursor: 'ns-resize' }}
                    onMouseDown={(event) => handleResizeHandleMouseDown(rect.region, 'n', event)}
                    title={`Resize ${rect.region.fieldName}`}
                  />
                  <button
                    type="button"
                    className={`${edgeBandClass} -bottom-[4px] left-[6px] right-[6px] h-[8px]`}
                    style={{ cursor: 'ns-resize' }}
                    onMouseDown={(event) => handleResizeHandleMouseDown(rect.region, 's', event)}
                    title={`Resize ${rect.region.fieldName}`}
                  />
                  <button
                    type="button"
                    className={`${edgeBandClass} top-[6px] -left-[4px] bottom-[6px] w-[8px]`}
                    style={{ cursor: 'ew-resize' }}
                    onMouseDown={(event) => handleResizeHandleMouseDown(rect.region, 'w', event)}
                    title={`Resize ${rect.region.fieldName}`}
                  />
                  <button
                    type="button"
                    className={`${edgeBandClass} top-[6px] -right-[4px] bottom-[6px] w-[8px]`}
                    style={{ cursor: 'ew-resize' }}
                    onMouseDown={(event) => handleResizeHandleMouseDown(rect.region, 'e', event)}
                    title={`Resize ${rect.region.fieldName}`}
                  />
                </>
              )}

              {/* Corner resize handles */}
              <button
                type="button"
                className={`absolute pointer-events-auto border border-white/90 shadow-none ${isActiveField ? 'h-[7px] w-[7px] -right-[4px] -bottom-[4px] bg-emerald-500 hover:bg-emerald-400' : 'h-[6px] w-[6px] -right-[3px] -bottom-[3px] bg-emerald-500/80 hover:bg-emerald-500'}`}
                style={{ cursor: 'nwse-resize' }}
                onMouseDown={(event) => handleResizeHandleMouseDown(rect.region, 'se', event)}
                title={`Resize ${rect.region.fieldName}`}
              />
              {!isSingleCell && (
                <>
                  <button
                    type="button"
                    className={`absolute pointer-events-auto border border-white/90 ${isActiveField ? 'h-[6px] w-[6px] -left-[4px] -top-[4px] bg-emerald-500/90 hover:bg-emerald-400' : 'h-[5px] w-[5px] -left-[3px] -top-[3px] bg-emerald-500/70 hover:bg-emerald-500'}`}
                    style={{ cursor: 'nwse-resize' }}
                    onMouseDown={(event) => handleResizeHandleMouseDown(rect.region, 'nw', event)}
                    title={`Resize ${rect.region.fieldName}`}
                  />
                  <button
                    type="button"
                    className={`absolute pointer-events-auto border border-white/90 ${isActiveField ? 'h-[6px] w-[6px] -right-[4px] -top-[4px] bg-emerald-500/90 hover:bg-emerald-400' : 'h-[5px] w-[5px] -right-[3px] -top-[3px] bg-emerald-500/70 hover:bg-emerald-500'}`}
                    style={{ cursor: 'nesw-resize' }}
                    onMouseDown={(event) => handleResizeHandleMouseDown(rect.region, 'ne', event)}
                    title={`Resize ${rect.region.fieldName}`}
                  />
                  <button
                    type="button"
                    className={`absolute pointer-events-auto border border-white/90 ${isActiveField ? 'h-[6px] w-[6px] -left-[4px] -bottom-[4px] bg-emerald-500/90 hover:bg-emerald-400' : 'h-[5px] w-[5px] -left-[3px] -bottom-[3px] bg-emerald-500/70 hover:bg-emerald-500'}`}
                    style={{ cursor: 'nesw-resize' }}
                    onMouseDown={(event) => handleResizeHandleMouseDown(rect.region, 'sw', event)}
                    title={`Resize ${rect.region.fieldName}`}
                  />
                </>
              )}
            </div>
          );
        })}
        {movePreviewRect && (
          <div
            className="absolute pointer-events-none"
            style={{
              top: movePreviewRect.top,
              left: movePreviewRect.left,
              width: movePreviewRect.width,
              height: movePreviewRect.height,
            }}
          >
            <div className="absolute inset-0 border-[3px] border-dashed border-emerald-400 shadow-[0_0_0_1px_rgba(255,255,255,0.35)] dark:border-emerald-200 dark:shadow-[0_0_0_1px_rgba(255,255,255,0.12),0_0_18px_rgba(110,231,183,0.28)]" />
            <div className="absolute inset-[3px] bg-emerald-400/20 dark:bg-emerald-300/28" />
            <div className="absolute -left-[4px] -top-[4px] h-2.5 w-2.5 border border-white/80 bg-emerald-400 dark:bg-emerald-200" />
            <div className="absolute -right-[4px] -top-[4px] h-2.5 w-2.5 border border-white/80 bg-emerald-400 dark:bg-emerald-200" />
            <div className="absolute -left-[4px] -bottom-[4px] h-2.5 w-2.5 border border-white/80 bg-emerald-400 dark:bg-emerald-200" />
            <div className="absolute -right-[4px] -bottom-[4px] h-2.5 w-2.5 border border-white/80 bg-emerald-400 dark:bg-emerald-200" />
            <div className="absolute -top-6 left-0 rounded-md border border-emerald-400/70 bg-background/95 px-2 py-0.5 text-[10px] font-mono text-emerald-700 shadow-sm dark:border-emerald-300/60 dark:bg-slate-950/95 dark:text-emerald-200">
              {movePreviewRect.fieldName} → {colIndexToLetter(movePreviewRect.start.col)}{movePreviewRect.start.row + 1}:{colIndexToLetter(movePreviewRect.end.col)}{movePreviewRect.end.row + 1}
            </div>
          </div>
        )}
        {activeSuggestionRect && (
          <div
            className="absolute pointer-events-none"
            style={{
              top: activeSuggestionRect.top,
              left: activeSuggestionRect.left,
              width: activeSuggestionRect.width,
              height: activeSuggestionRect.height,
            }}
          >
            <div
              className="absolute inset-0 border-2 border-orange-500 pointer-events-none"
              style={{ boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.18)' }}
            />
            <div className="absolute inset-[2px] bg-orange-500/5 pointer-events-none" />
            {!(activeSuggestionRect.region.start.col === activeSuggestionRect.region.end.col
              && activeSuggestionRect.region.start.row === activeSuggestionRect.region.end.row) && (
              <>
                <button
                  type="button"
                  onMouseDown={(event) => handleSuggestionResizeHandleMouseDown(activeSuggestionRect.region, 'n', event)}
                  className={`${edgeBandClass} -top-[4px] left-[6px] right-[6px] h-[8px]`}
                  style={{ cursor: 'ns-resize' }}
                  title="Resize suggestion"
                />
                <button
                  type="button"
                  onMouseDown={(event) => handleSuggestionResizeHandleMouseDown(activeSuggestionRect.region, 's', event)}
                  className={`${edgeBandClass} -bottom-[4px] left-[6px] right-[6px] h-[8px]`}
                  style={{ cursor: 'ns-resize' }}
                  title="Resize suggestion"
                />
                <button
                  type="button"
                  onMouseDown={(event) => handleSuggestionResizeHandleMouseDown(activeSuggestionRect.region, 'w', event)}
                  className={`${edgeBandClass} top-[6px] -left-[4px] bottom-[6px] w-[8px]`}
                  style={{ cursor: 'ew-resize' }}
                  title="Resize suggestion"
                />
                <button
                  type="button"
                  onMouseDown={(event) => handleSuggestionResizeHandleMouseDown(activeSuggestionRect.region, 'e', event)}
                  className={`${edgeBandClass} top-[6px] -right-[4px] bottom-[6px] w-[8px]`}
                  style={{ cursor: 'ew-resize' }}
                  title="Resize suggestion"
                />
                <button
                  type="button"
                  onMouseDown={(event) => handleSuggestionResizeHandleMouseDown(activeSuggestionRect.region, 'nw', event)}
                  className="absolute -left-[4px] -top-[4px] h-[6px] w-[6px] border border-white/90 bg-orange-500/90 pointer-events-auto hover:bg-orange-400"
                  style={{ cursor: 'nwse-resize' }}
                  title="Resize suggestion"
                />
                <button
                  type="button"
                  onMouseDown={(event) => handleSuggestionResizeHandleMouseDown(activeSuggestionRect.region, 'ne', event)}
                  className="absolute -right-[4px] -top-[4px] h-[6px] w-[6px] border border-white/90 bg-orange-500/90 pointer-events-auto hover:bg-orange-400"
                  style={{ cursor: 'nesw-resize' }}
                  title="Resize suggestion"
                />
                <button
                  type="button"
                  onMouseDown={(event) => handleSuggestionResizeHandleMouseDown(activeSuggestionRect.region, 'sw', event)}
                  className="absolute -left-[4px] -bottom-[4px] h-[6px] w-[6px] border border-white/90 bg-orange-500/90 pointer-events-auto hover:bg-orange-400"
                  style={{ cursor: 'nesw-resize' }}
                  title="Resize suggestion"
                />
              </>
            )}
            <button
              type="button"
              onMouseDown={(event) => handleSuggestionResizeHandleMouseDown(activeSuggestionRect.region, 'se', event)}
              className="absolute -right-[4px] -bottom-[4px] h-[7px] w-[7px] border border-white/90 bg-orange-500 pointer-events-auto hover:bg-orange-400"
              style={{ cursor: 'nwse-resize' }}
              title="Resize suggestion"
            />
          </div>
        )}
        </div>
      </div>
      </div>

    </div>
  );
}
