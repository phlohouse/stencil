import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SheetData, CellValue, CellStyle } from '../lib/excel';
import type { CellAddress, Selection, StencilField } from '../lib/types';
import type { SchemaSuggestion } from '../lib/suggestions';
import { colIndexToLetter, letterToColIndex, normalizeRange, parseAddress } from '../lib/addressing';

type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

interface SpreadsheetViewProps {
  sheetData: SheetData;
  sheetNames: string[];
  activeSheet: string;
  selection: Selection | null;
  fields: StencilField[];
  discriminatorCells?: string[];
  suggestions?: SchemaSuggestion[];
  activeSuggestionId?: string | null;
  suggestionPreviewSelection?: Selection | null;
  onSwitchSheet: (name: string) => void;
  onStartSelection: (addr: CellAddress) => void;
  onExtendSelection: (addr: CellAddress) => void;
  onSetSelection: (start: CellAddress, end: CellAddress) => void;
  onStartResizeField: (fieldName: string) => void;
  onStartMoveField: (fieldName: string) => void;
  onStartResizeSuggestion: (suggestionId: string) => void;
  onEndSelection: () => void;
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

const MAX_VISIBLE_ROWS = 200;
const MAX_VISIBLE_COLS = 50;
const DRAG_THRESHOLD_PX = 4;

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

function getOpenEndedRangeEndRow(
  sheetData: SheetData,
  startRow: number,
  startCol: number,
  endCol: number,
  maxVisibleRows: number,
): number {
  const lastRow = Math.min(maxVisibleRows - 1, sheetData.rows - 1);
  let endRow = startRow - 1;

  for (let r = startRow; r <= lastRow; r++) {
    let allEmpty = true;
    for (let c = startCol; c <= endCol; c++) {
      const value = sheetData.cells[r]?.[c]?.value ?? null;
      if (value !== null && value !== '') {
        allEmpty = false;
        break;
      }
    }
    if (allEmpty) break;
    endRow = r;
  }

  return endRow;
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

export function SpreadsheetView({
  sheetData,
  sheetNames,
  activeSheet,
  selection,
  fields,
  discriminatorCells,
  suggestions,
  activeSuggestionId,
  suggestionPreviewSelection,
  onSwitchSheet,
  onStartSelection,
  onExtendSelection,
  onSetSelection,
  onStartResizeField,
  onStartMoveField,
  onStartResizeSuggestion,
  onEndSelection,
}: SpreadsheetViewProps) {
  const tableRef = useRef<HTMLDivElement>(null);
  const isMouseSelectingRef = useRef(false);
  const dragStartPosRef = useRef<{ x: number; y: number } | null>(null);
  const dragThresholdPassedRef = useRef(false);
  const resizeAnchorRef = useRef<{ anchor: CellAddress; handle: ResizeHandle } | null>(null);
  const moveStateRef = useRef<{ fieldName: string; originCol: number; originRow: number; region: FieldRegion } | null>(null);
  const overlayDragRef = useRef(false);
  const overlayContainerRef = useRef<HTMLDivElement>(null);
  const lastOverlayCellRef = useRef<{ col: number; row: number } | null>(null);
  const rafIdRef = useRef<number>(0);
  const [showHiddenColumns, setShowHiddenColumns] = useState(false);

  const visibleRows = Math.min(sheetData.rows, MAX_VISIBLE_ROWS);
  const visibleCols = Math.min(sheetData.cols, MAX_VISIBLE_COLS);
  const visibleColumnIndices = useMemo(
    () => Array.from({ length: sheetData.cols }, (_, col) => col)
      .filter((col) => showHiddenColumns || !sheetData.hiddenCols[col])
      .slice(0, MAX_VISIBLE_COLS),
    [sheetData.cols, sheetData.hiddenCols, showHiddenColumns],
  );

  const normalizedSelection = useMemo(() => {
    if (!selection) return null;
    return normalizeRange(selection.start, selection.end);
  }, [selection]);

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
        if (ref) {
          try {
            const parsed = parseAddress(ref.toUpperCase());
            if (parsed.row < visibleRows && parsed.col < visibleCols) {
              const key = `${colIndexToLetter(parsed.col)}${parsed.row + 1}`;
              cells.set(key, field.name);
              regions.push({
                fieldName: field.name,
                start: parsed,
                end: parsed,
              });
            }
          } catch {
            // Ignore invalid refs in view rendering.
          }
        }
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
          ? getOpenEndedRangeEndRow(sheetData, startRow, startCol, endCol, visibleRows)
          : Math.max(parsed.start.row, parsed.end.row);

        if (endRow < startRow) continue;

        regions.push({
          fieldName: field.name,
          start: { col: startCol, row: startRow },
          end: { col: Math.min(endCol, visibleCols - 1), row: Math.min(endRow, visibleRows - 1) },
        });

        for (let r = startRow; r <= endRow && r < visibleRows; r++) {
          for (let c = startCol; c <= endCol && c < visibleCols; c++) {
            cells.set(`${colIndexToLetter(c)}${r + 1}`, field.name);
          }
        }
      }
    }
    return { cells, regions };
  }, [fields, activeSheet, sheetNames, visibleRows, visibleCols, sheetData]);

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
        ? getOpenEndedRangeEndRow(sheetData, startRow, startCol, endCol, visibleRows)
        : Math.max(parsed.start.row, parsed.end.row);

      if (endRow < startRow) continue;

      const label = suggestion.kind === 'discriminator'
        ? `Suggestion: discriminator ${suggestion.discriminatorValue}`
        : `Suggestion: ${suggestion.field.name}`;

      const baseRegion: SuggestionRegion = {
        suggestionId: suggestion.id,
        label,
        start: { col: startCol, row: startRow },
        end: { col: Math.min(endCol, visibleCols - 1), row: Math.min(endRow, visibleRows - 1) },
      };
      const region = suggestion.id === activeSuggestionId && suggestionPreviewSelection
        ? {
            ...baseRegion,
            start: {
              col: Math.min(suggestionPreviewSelection.start.col, visibleCols - 1),
              row: Math.min(suggestionPreviewSelection.start.row, visibleRows - 1),
            },
            end: {
              col: Math.min(suggestionPreviewSelection.end.col, visibleCols - 1),
              row: Math.min(suggestionPreviewSelection.end.row, visibleRows - 1),
            },
          }
        : baseRegion;
      regions.push(region);

      for (let r = region.start.row; r <= region.end.row && r < visibleRows; r++) {
        for (let c = region.start.col; c <= region.end.col && c < visibleCols; c++) {
          cells.set(`${colIndexToLetter(c)}${r + 1}`, region);
        }
      }
    }

    return { cells, regions };
  }, [activeSheet, activeSuggestionId, sheetData, sheetNames, suggestionPreviewSelection, suggestions, visibleCols, visibleRows]);

  const activeSuggestionRegion = useMemo(
    () => suggestionCells.regions.find((region) => region.suggestionId === activeSuggestionId),
    [activeSuggestionId, suggestionCells.regions],
  );

  const isInSelection = useCallback(
    (col: number, row: number) => {
      if (!normalizedSelection) return false;
      const { start, end } = normalizedSelection;
      return col >= start.col && col <= end.col && row >= start.row && row <= end.row;
    },
    [normalizedSelection],
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

  const handleMouseDown = useCallback(
    (col: number, row: number, event: React.MouseEvent<HTMLTableCellElement>) => {
      isMouseSelectingRef.current = true;
      dragStartPosRef.current = { x: event.clientX, y: event.clientY };
      dragThresholdPassedRef.current = false;
      onStartSelection({ col, row });
    },
    [onStartSelection],
  );

  const handleMouseEnter = useCallback(
    (col: number, row: number, event: React.MouseEvent<HTMLTableCellElement>) => {
      if (!isMouseSelectingRef.current) return;

      if (!dragThresholdPassedRef.current) {
        const start = dragStartPosRef.current;
        if (start) {
          const dx = Math.abs(event.clientX - start.x);
          const dy = Math.abs(event.clientY - start.y);
          if (dx < DRAG_THRESHOLD_PX && dy < DRAG_THRESHOLD_PX) {
            return;
          }
        }
        dragThresholdPassedRef.current = true;
      }

      // Move mode: offset the entire region
      const ms = moveStateRef.current;
      if (ms) {
        const dc = col - ms.originCol;
        const dr = row - ms.originRow;
        const newStart = {
          col: ms.region.start.col + dc,
          row: ms.region.start.row + dr,
        };
        const newEnd = {
          col: ms.region.end.col + dc,
          row: ms.region.end.row + dr,
        };
        if (newStart.col >= 0 && newStart.row >= 0 && newEnd.col < visibleCols && newEnd.row < visibleRows) {
          onSetSelection(newStart, newEnd);
        }
        return;
      }

      // Resize mode: keep anchor fixed, extend to dragged cell
      const ra = resizeAnchorRef.current;
      if (ra) {
        onExtendSelection({ col, row });
        return;
      }

      onExtendSelection({ col, row });
    },
    [onExtendSelection, onSetSelection, visibleCols, visibleRows],
  );

  const handleMouseUp = useCallback(() => {
    if (!isMouseSelectingRef.current) return;
    isMouseSelectingRef.current = false;
    dragStartPosRef.current = null;
    dragThresholdPassedRef.current = false;
    resizeAnchorRef.current = null;
    moveStateRef.current = null;
    overlayDragRef.current = false;
    onEndSelection();
  }, [onEndSelection]);

  const handleResizeHandleMouseDown = useCallback(
    (
      region: FieldRegion,
      handle: ResizeHandle,
      event: React.MouseEvent<HTMLButtonElement>,
    ) => {
      event.preventDefault();
      event.stopPropagation();
      isMouseSelectingRef.current = true;
      dragStartPosRef.current = { x: event.clientX, y: event.clientY };
      dragThresholdPassedRef.current = true;

      // The anchor is the opposite corner from the handle being dragged
      const anchorMap: Record<ResizeHandle, CellAddress> = {
        nw: region.end,
        ne: { col: region.start.col, row: region.end.row },
        sw: { col: region.end.col, row: region.start.row },
        se: region.start,
        n: { col: region.start.col, row: region.end.row },
        s: { col: region.start.col, row: region.start.row },
        w: { col: region.end.col, row: region.start.row },
        e: { col: region.start.col, row: region.start.row },
      };
      resizeAnchorRef.current = { anchor: anchorMap[handle], handle };
      overlayDragRef.current = true;

      onStartResizeField(region.fieldName);
      onStartSelection(anchorMap[handle]);
      // Set the dragged corner as the current "end"
      const dragCornerMap: Record<ResizeHandle, CellAddress> = {
        nw: region.start,
        ne: { col: region.end.col, row: region.start.row },
        sw: { col: region.start.col, row: region.end.row },
        se: region.end,
        n: region.start,
        s: region.end,
        w: region.start,
        e: region.end,
      };
      onExtendSelection(dragCornerMap[handle]);
    },
    [onStartResizeField, onStartSelection, onExtendSelection],
  );

  const handleBorderMoveMouseDown = useCallback(
    (
      region: FieldRegion,
      col: number,
      row: number,
      event: React.MouseEvent<HTMLDivElement>,
    ) => {
      event.preventDefault();
      event.stopPropagation();
      isMouseSelectingRef.current = true;
      dragStartPosRef.current = { x: event.clientX, y: event.clientY };
      dragThresholdPassedRef.current = true;
      moveStateRef.current = {
        fieldName: region.fieldName,
        originCol: col,
        originRow: row,
        region,
      };
      overlayDragRef.current = true;
      onStartMoveField(region.fieldName);
      onStartSelection(region.start);
      onExtendSelection(region.end);
    },
    [onStartMoveField, onStartSelection, onExtendSelection],
  );

  const handleSuggestionResizeHandleMouseDown = useCallback(
    (
      region: SuggestionRegion,
      event: React.MouseEvent<HTMLButtonElement>,
    ) => {
      event.preventDefault();
      event.stopPropagation();
      isMouseSelectingRef.current = true;
      dragStartPosRef.current = { x: event.clientX, y: event.clientY };
      dragThresholdPassedRef.current = true;
      onStartResizeSuggestion(region.suggestionId);
      onStartSelection(region.start);
      onExtendSelection(region.end);
    },
    [onStartResizeSuggestion, onStartSelection, onExtendSelection],
  );

  // Resolve a cell address from a mouse event by peeking through the overlay
  const resolveCellFromPoint = useCallback((clientX: number, clientY: number): { col: number; row: number } | null => {
    const overlays = overlayContainerRef.current;
    if (overlays) overlays.style.visibility = 'hidden';
    const el = document.elementFromPoint(clientX, clientY);
    if (overlays) overlays.style.visibility = '';
    const td = el?.closest('td[data-cell-ref]') as HTMLElement | null;
    if (!td) return null;
    const ref = td.dataset.cellRef;
    if (!ref) return null;
    const match = ref.match(/^([A-Z]+)(\d+)$/);
    if (!match) return null;
    return { col: letterToColIndex(match[1]), row: parseInt(match[2], 10) - 1 };
  }, []);

  useEffect(() => {
    const onWindowMouseMove = (event: MouseEvent) => {
      if (!isMouseSelectingRef.current || !overlayDragRef.current) return;

      // Throttle to one update per animation frame
      cancelAnimationFrame(rafIdRef.current);
      const clientX = event.clientX;
      const clientY = event.clientY;
      rafIdRef.current = requestAnimationFrame(() => {
        const cell = resolveCellFromPoint(clientX, clientY);
        if (!cell) return;

        // Skip if cell hasn't changed
        const last = lastOverlayCellRef.current;
        if (last && last.col === cell.col && last.row === cell.row) return;
        lastOverlayCellRef.current = cell;

        const ms = moveStateRef.current;
        if (ms) {
          const dc = cell.col - ms.originCol;
          const dr = cell.row - ms.originRow;
          const newStart = { col: ms.region.start.col + dc, row: ms.region.start.row + dr };
          const newEnd = { col: ms.region.end.col + dc, row: ms.region.end.row + dr };
          if (newStart.col >= 0 && newStart.row >= 0 && newEnd.col < visibleCols && newEnd.row < visibleRows) {
            onSetSelection(newStart, newEnd);
          }
          return;
        }
        if (resizeAnchorRef.current) {
          onExtendSelection(cell);
          return;
        }
      });
    };

    const onWindowMouseUp = () => {
      if (!isMouseSelectingRef.current) return;
      cancelAnimationFrame(rafIdRef.current);
      isMouseSelectingRef.current = false;
      dragStartPosRef.current = null;
      dragThresholdPassedRef.current = false;
      resizeAnchorRef.current = null;
      moveStateRef.current = null;
      overlayDragRef.current = false;
      lastOverlayCellRef.current = null;
      onEndSelection();
    };

    window.addEventListener('mousemove', onWindowMouseMove);
    window.addEventListener('mouseup', onWindowMouseUp);
    return () => {
      cancelAnimationFrame(rafIdRef.current);
      window.removeEventListener('mousemove', onWindowMouseMove);
      window.removeEventListener('mouseup', onWindowMouseUp);
    };
  }, [onEndSelection, onExtendSelection, onSetSelection, resolveCellFromPoint, visibleCols, visibleRows]);

  useEffect(() => {
    // Don't auto-scroll while actively dragging (move/resize from overlay)
    if (isMouseSelectingRef.current) return;
    if (!normalizedSelection || !tableRef.current) return;
    const container = tableRef.current;
    const startRef = `${colIndexToLetter(normalizedSelection.start.col)}${normalizedSelection.start.row + 1}`;
    const endRef = `${colIndexToLetter(normalizedSelection.end.col)}${normalizedSelection.end.row + 1}`;
    const startCell = container.querySelector<HTMLElement>(`[data-cell-ref="${startRef}"]`);
    const endCell = container.querySelector<HTMLElement>(`[data-cell-ref="${endRef}"]`) ?? startCell;
    if (!startCell || !endCell) return;

    const startLeft = startCell.offsetLeft;
    const startTop = startCell.offsetTop;
    const endLeft = endCell.offsetLeft + endCell.offsetWidth;
    const endTop = endCell.offsetTop + endCell.offsetHeight;
    const targetCenterLeft = (startLeft + endLeft) / 2;
    const targetCenterTop = (startTop + endTop) / 2;
    const nextScrollLeft = Math.max(0, targetCenterLeft - container.clientWidth / 2);
    const nextScrollTop = Math.max(0, targetCenterTop - container.clientHeight / 2);

    container.scrollTo({
      left: nextScrollLeft,
      top: nextScrollTop,
      behavior: 'smooth',
    });
  }, [activeSheet, normalizedSelection]);

  // --- Region overlay measurement ---
  interface OverlayRect {
    key: string;
    top: number;
    left: number;
    width: number;
    height: number;
    region: FieldRegion;
  }

  const [overlayRects, setOverlayRects] = useState<OverlayRect[]>([]);

  const measureOverlays = useCallback(() => {
    const container = tableRef.current;
    if (!container) return;

    const rects: OverlayRect[] = [];
    for (const region of mappedFieldCells.regions) {
      const startRef = `${colIndexToLetter(region.start.col)}${region.start.row + 1}`;
      const endRef = `${colIndexToLetter(region.end.col)}${region.end.row + 1}`;
      const startCell = container.querySelector<HTMLElement>(`[data-cell-ref="${startRef}"]`);
      const endCell = container.querySelector<HTMLElement>(`[data-cell-ref="${endRef}"]`) ?? startCell;
      if (!startCell || !endCell) continue;

      rects.push({
        key: region.fieldName,
        top: startCell.offsetTop,
        left: startCell.offsetLeft,
        width: endCell.offsetLeft + endCell.offsetWidth - startCell.offsetLeft,
        height: endCell.offsetTop + endCell.offsetHeight - startCell.offsetTop,
        region,
      });
    }
    setOverlayRects(rects);
  }, [mappedFieldCells.regions]);

  useLayoutEffect(() => {
    measureOverlays();
  }, [measureOverlays]);

  // Re-measure on scroll (positions are relative to the table, not viewport, so
  // we only need to remeasure if the table layout changes — but call it on resize too).
  useEffect(() => {
    const container = tableRef.current;
    if (!container) return;

    const observer = new ResizeObserver(() => measureOverlays());
    observer.observe(container);
    return () => observer.disconnect();
  }, [measureOverlays]);

  return (
    <div className="flex flex-col h-full">
      {/* Spreadsheet grid */}
      <div
        ref={tableRef}
        className="flex-1 overflow-auto relative"
        onMouseUp={handleMouseUp}
      >
        <table className="border-collapse text-xs select-none">
          <thead className="sticky top-0 z-10">
            <tr>
              <th className="bg-elevated border border-border px-2 py-1 text-text-secondary min-w-[40px] sticky left-0 z-20" />
              {visibleColumnIndices.map((colIndex) => (
                <th
                  key={colIndex}
                  className="bg-elevated border border-border px-2 py-1 text-text-secondary font-mono font-normal min-w-[80px]"
                >
                  {colIndexToLetter(colIndex)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: visibleRows }, (_, r) => (
              <tr key={r}>
                <td className="bg-elevated border border-border px-2 py-1 text-text-secondary font-mono text-right sticky left-0 z-[5]">
                  {r + 1}
                </td>
                {visibleColumnIndices.map((c) => {
                  const inSelection = isInSelection(c, r);
                  const isDisc = isDiscriminator(c, r);
                  const fieldName = getFieldForCell(c, r);
                  const suggestionRegion = getSuggestionForCell(c, r);
                  const isActiveSuggestion = suggestionRegion?.suggestionId === activeSuggestionId;
                  const cellInfo = sheetData.cells[r]?.[c];
                  const value = cellInfo?.value ?? null;
                  const cellStyle = cellInfo?.style;
                  const merge = cellInfo?.merge;
                  const rendersActiveSuggestionHandle = Boolean(
                    activeSuggestionRegion
                    && suggestionRegion?.suggestionId === activeSuggestionId
                    && (
                      merge
                        ? activeSuggestionRegion.end.col >= merge.left
                          && activeSuggestionRegion.end.col <= merge.right
                          && activeSuggestionRegion.end.row >= merge.top
                          && activeSuggestionRegion.end.row <= merge.bottom
                        : activeSuggestionRegion.end.col === c && activeSuggestionRegion.end.row === r
                    ),
                  );

                  if (merge && !merge.isAnchor) {
                    return null;
                  }

                  let cellClass =
                    'px-2 py-1 font-mono whitespace-nowrap cursor-cell ';

                  if (isDisc) {
                    cellClass += 'bg-amber-500/20 border border-amber-500/50 ';
                  } else if (fieldName) {
                    cellClass += 'bg-cell ';
                  } else if (isActiveSuggestion) {
                    cellClass += 'bg-fuchsia-500/22 border border-fuchsia-400/70 ';
                  } else if (suggestionRegion) {
                    cellClass += 'bg-violet-500/14 border border-violet-400/45 ';
                  } else if (inSelection) {
                    cellClass += 'bg-accent/20 border border-accent/50 ';
                  } else {
                    cellClass += 'bg-cell hover:bg-cell-hover ';
                  }

                  // Only apply default border if no Excel border is set
                  if (!cellStyle?.borderTop && !cellStyle?.borderBottom &&
                      !cellStyle?.borderLeft && !cellStyle?.borderRight &&
                      !isDisc && !inSelection) {
                    cellClass += 'border border-cell-border ';
                  }

                  return (
                    <td
                      key={c}
                      data-cell-ref={`${colIndexToLetter(c)}${r + 1}`}
                      className={`${cellClass} relative`}
                      style={styleToCSS(cellStyle)}
                      rowSpan={merge ? (merge.bottom - merge.top + 1) : undefined}
                      colSpan={merge ? (merge.right - merge.left + 1) : undefined}
                      onMouseDown={(event) => handleMouseDown(c, r, event)}
                      onMouseEnter={(event) => handleMouseEnter(c, r, event)}
                      title={
                        fieldName
                          ? `Field: ${fieldName}${typeof value === 'string' && value ? `\nValue: ${value}` : ''}`
                          : suggestionRegion
                            ? `${suggestionRegion.label}${typeof value === 'string' && value ? `\nValue: ${value}` : ''}`
                          : typeof value === 'string' && value
                            ? value
                            : undefined
                      }
                    >
                      {formatCellDisplay(value)}
                      {rendersActiveSuggestionHandle && activeSuggestionRegion && (
                        <button
                          type="button"
                          onMouseDown={(event) => handleSuggestionResizeHandleMouseDown(activeSuggestionRegion, event)}
                          className="absolute right-0 bottom-0 h-[7px] w-[7px] translate-x-[3px] translate-y-[3px] rounded-full bg-fuchsia-400 hover:bg-fuchsia-200 border border-fuchsia-600/60 z-[6] shadow-sm shadow-fuchsia-900/40"
                          style={{ cursor: 'nwse-resize' }}
                          title="Resize suggestion"
                        />
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>

        {/* Field region overlays — single continuous border per region */}
        <div ref={overlayContainerRef}>
        {overlayRects.map((rect) => {
          const isSingleCell = rect.region.start.col === rect.region.end.col
            && rect.region.start.row === rect.region.end.row;

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
                className="absolute inset-0 rounded-[1px] border-2 border-cyan-400/70 pointer-events-none"
                style={{ boxShadow: '0 0 0 1px rgba(8, 145, 178, 0.15)' }}
              />

              {/* Move area — 4 edge strips form a border band that's grabbable */}
              {!isSingleCell && (() => {
                const edgeHandler = (event: React.MouseEvent<HTMLDivElement>) => {
                  const cell = resolveCellFromPoint(event.clientX, event.clientY);
                  if (!cell) return;
                  handleBorderMoveMouseDown(rect.region, cell.col, cell.row, event as unknown as React.MouseEvent<HTMLDivElement>);
                };
                const edgeClass = "absolute pointer-events-auto cursor-grab active:cursor-grabbing hover:bg-cyan-400/25 transition-colors";
                const BAND = 6; // px width of grabbable edge band
                return (
                  <>
                    {/* Top edge */}
                    <div className={edgeClass} style={{ top: -1, left: 0, right: 0, height: BAND }} onMouseDown={edgeHandler} title={`Move ${rect.region.fieldName}`} />
                    {/* Bottom edge */}
                    <div className={edgeClass} style={{ bottom: -1, left: 0, right: 0, height: BAND }} onMouseDown={edgeHandler} title={`Move ${rect.region.fieldName}`} />
                    {/* Left edge */}
                    <div className={edgeClass} style={{ top: BAND, left: -1, bottom: BAND, width: BAND }} onMouseDown={edgeHandler} title={`Move ${rect.region.fieldName}`} />
                    {/* Right edge */}
                    <div className={edgeClass} style={{ top: BAND, right: -1, bottom: BAND, width: BAND }} onMouseDown={edgeHandler} title={`Move ${rect.region.fieldName}`} />
                  </>
                );
              })()}

              {/* Corner resize handles */}
              <button
                type="button"
                className="absolute -right-[5px] -bottom-[5px] h-[10px] w-[10px] rounded-full bg-cyan-400 hover:bg-cyan-100 border-2 border-cyan-300 pointer-events-auto shadow-[0_0_4px_rgba(34,211,238,0.5)]"
                style={{ cursor: 'nwse-resize' }}
                onMouseDown={(event) => handleResizeHandleMouseDown(rect.region, 'se', event)}
                title={`Resize ${rect.region.fieldName}`}
              />
              {!isSingleCell && (
                <>
                  <button
                    type="button"
                    className="absolute -left-[5px] -top-[5px] h-[10px] w-[10px] rounded-full bg-cyan-400 hover:bg-cyan-100 border-2 border-cyan-300 pointer-events-auto shadow-[0_0_4px_rgba(34,211,238,0.5)]"
                    style={{ cursor: 'nwse-resize' }}
                    onMouseDown={(event) => handleResizeHandleMouseDown(rect.region, 'nw', event)}
                    title={`Resize ${rect.region.fieldName}`}
                  />
                  <button
                    type="button"
                    className="absolute -right-[5px] -top-[5px] h-[10px] w-[10px] rounded-full bg-cyan-400 hover:bg-cyan-100 border-2 border-cyan-300 pointer-events-auto shadow-[0_0_4px_rgba(34,211,238,0.5)]"
                    style={{ cursor: 'nesw-resize' }}
                    onMouseDown={(event) => handleResizeHandleMouseDown(rect.region, 'ne', event)}
                    title={`Resize ${rect.region.fieldName}`}
                  />
                  <button
                    type="button"
                    className="absolute -left-[5px] -bottom-[5px] h-[10px] w-[10px] rounded-full bg-cyan-400 hover:bg-cyan-100 border-2 border-cyan-300 pointer-events-auto shadow-[0_0_4px_rgba(34,211,238,0.5)]"
                    style={{ cursor: 'nesw-resize' }}
                    onMouseDown={(event) => handleResizeHandleMouseDown(rect.region, 'sw', event)}
                    title={`Resize ${rect.region.fieldName}`}
                  />
                </>
              )}
            </div>
          );
        })}
        </div>
      </div>

      {/* Sheet tabs */}
      <div className="flex items-center border-t border-border bg-surface">
        {sheetNames.map((name) => (
          <button
            key={name}
            onClick={() => onSwitchSheet(name)}
            className={`px-4 py-2 text-xs font-medium transition-colors border-r border-border
            ${name === activeSheet
                ? 'bg-elevated text-text'
                : 'text-text-secondary hover:text-text hover:bg-elevated/50'
              }`}
          >
            {name}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setShowHiddenColumns((current) => !current)}
          className="ml-auto px-3 py-2 text-xs text-text-secondary hover:text-text border-l border-border"
        >
          {showHiddenColumns ? 'Hide Hidden Cols' : 'Show Hidden Cols'}
        </button>
      </div>
    </div>
  );
}
