import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SheetData, CellValue, CellStyle } from '../lib/excel';
import type { CellAddress, Selection, StencilField } from '../lib/types';
import type { SchemaSuggestion } from '../lib/suggestions';
import { colIndexToLetter, letterToColIndex, normalizeRange, parseAddress } from '../lib/addressing';

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
  onStartResizeField: (fieldName: string) => void;
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
  onStartResizeField,
  onStartResizeSuggestion,
  onEndSelection,
}: SpreadsheetViewProps) {
  const tableRef = useRef<HTMLDivElement>(null);
  const isMouseSelectingRef = useRef(false);
  const dragStartPosRef = useRef<{ x: number; y: number } | null>(null);
  const dragThresholdPassedRef = useRef(false);
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

  const resizeHandleMap = useMemo(() => {
    const handles = new Map<string, FieldRegion>();
    for (const region of mappedFieldCells.regions) {
      const key = `${region.end.col},${region.end.row}`;
      handles.set(key, region);
    }
    return handles;
  }, [mappedFieldCells.regions]);

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

  const getResizeRegionForCell = useCallback(
    (col: number, row: number): FieldRegion | undefined => {
      return resizeHandleMap.get(`${col},${row}`);
    },
    [resizeHandleMap],
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

      onExtendSelection({ col, row });
    },
    [onExtendSelection],
  );

  const handleMouseUp = useCallback(() => {
    if (!isMouseSelectingRef.current) return;
    isMouseSelectingRef.current = false;
    dragStartPosRef.current = null;
    dragThresholdPassedRef.current = false;
    onEndSelection();
  }, [onEndSelection]);

  const handleResizeHandleMouseDown = useCallback(
    (
      region: FieldRegion,
      event: React.MouseEvent<HTMLButtonElement>,
    ) => {
      event.preventDefault();
      event.stopPropagation();
      isMouseSelectingRef.current = true;
      dragStartPosRef.current = { x: event.clientX, y: event.clientY };
      dragThresholdPassedRef.current = true;
      onStartResizeField(region.fieldName);
      onStartSelection(region.start);
      onExtendSelection(region.end);
    },
    [onStartResizeField, onStartSelection, onExtendSelection],
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

  useEffect(() => {
    const onWindowMouseUp = () => {
      if (!isMouseSelectingRef.current) return;
      isMouseSelectingRef.current = false;
      dragStartPosRef.current = null;
      dragThresholdPassedRef.current = false;
      onEndSelection();
    };

    window.addEventListener('mouseup', onWindowMouseUp);
    return () => {
      window.removeEventListener('mouseup', onWindowMouseUp);
    };
  }, [onEndSelection]);

  useEffect(() => {
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

  return (
    <div className="flex flex-col h-full">
      {/* Spreadsheet grid */}
      <div
        ref={tableRef}
        className="flex-1 overflow-auto"
        onMouseUp={handleMouseUp}
      >
        <table className="border-collapse text-xs select-none">
          <thead className="sticky top-0 z-10">
            <tr>
              <th className="bg-gray-800 border border-gray-700 px-2 py-1 text-gray-400 min-w-[40px] sticky left-0 z-20" />
              {visibleColumnIndices.map((colIndex) => (
                <th
                  key={colIndex}
                  className="bg-gray-800 border border-gray-700 px-2 py-1 text-gray-400 font-mono font-normal min-w-[80px]"
                >
                  {colIndexToLetter(colIndex)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: visibleRows }, (_, r) => (
              <tr key={r}>
                <td className="bg-gray-800 border border-gray-700 px-2 py-1 text-gray-400 font-mono text-right sticky left-0 z-[5]">
                  {r + 1}
                </td>
                {visibleColumnIndices.map((c) => {
                  const inSelection = isInSelection(c, r);
                  const isDisc = isDiscriminator(c, r);
                  const fieldName = getFieldForCell(c, r);
                  const resizeRegion = getResizeRegionForCell(c, r);
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
                    cellClass += 'bg-cyan-500/20 border border-cyan-500/35 ';
                  } else if (isActiveSuggestion) {
                    cellClass += 'bg-fuchsia-500/22 border border-fuchsia-400/70 ';
                  } else if (suggestionRegion) {
                    cellClass += 'bg-violet-500/14 border border-violet-400/45 ';
                  } else if (inSelection) {
                    cellClass += 'bg-blue-500/20 border border-blue-400/50 ';
                  } else {
                    cellClass += 'bg-gray-900 hover:bg-gray-800/80 ';
                  }

                  // Only apply default border if no Excel border is set
                  if (!cellStyle?.borderTop && !cellStyle?.borderBottom &&
                      !cellStyle?.borderLeft && !cellStyle?.borderRight &&
                      !isDisc && !fieldName && !inSelection) {
                    cellClass += 'border border-gray-800 ';
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
                      {resizeRegion && (
                        <button
                          type="button"
                          onMouseDown={(event) => handleResizeHandleMouseDown(resizeRegion, event)}
                          className="absolute right-0 bottom-0 h-2.5 w-2.5 translate-x-[1px] translate-y-[1px] rounded-sm bg-cyan-300/80 hover:bg-cyan-200 border border-cyan-700/40 cursor-se-resize"
                          title={`Resize ${resizeRegion.fieldName}`}
                        />
                      )}
                      {rendersActiveSuggestionHandle && !resizeRegion && activeSuggestionRegion && (
                        <button
                          type="button"
                          onMouseDown={(event) => handleSuggestionResizeHandleMouseDown(activeSuggestionRegion, event)}
                          className="absolute right-0 bottom-0 h-2.5 w-2.5 translate-x-[1px] translate-y-[1px] rounded-sm bg-fuchsia-300/80 hover:bg-fuchsia-200 border border-fuchsia-700/40 cursor-se-resize"
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
      </div>

      {/* Sheet tabs */}
      <div className="flex items-center border-t border-gray-700 bg-gray-900">
        {sheetNames.map((name) => (
          <button
            key={name}
            onClick={() => onSwitchSheet(name)}
            className={`px-4 py-2 text-xs font-medium transition-colors border-r border-gray-700
            ${name === activeSheet
                ? 'bg-gray-800 text-white'
                : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/50'
              }`}
          >
            {name}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setShowHiddenColumns((current) => !current)}
          className="ml-auto px-3 py-2 text-xs text-gray-400 hover:text-gray-200 border-l border-gray-700"
        >
          {showHiddenColumns ? 'Hide Hidden Cols' : 'Show Hidden Cols'}
        </button>
      </div>
    </div>
  );
}
