import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { SheetData, CellValue, CellStyle } from '../lib/excel';
import type { CellAddress, Selection, StencilField } from '../lib/types';
import { colIndexToLetter, letterToColIndex, normalizeRange, parseAddress } from '../lib/addressing';

interface SpreadsheetViewProps {
  sheetData: SheetData;
  sheetNames: string[];
  activeSheet: string;
  selection: Selection | null;
  fields: StencilField[];
  discriminatorCell: string;
  onSwitchSheet: (name: string) => void;
  onStartSelection: (addr: CellAddress) => void;
  onExtendSelection: (addr: CellAddress) => void;
  onStartResizeField: (fieldName: string) => void;
  onEndSelection: () => void;
}

interface FieldRegion {
  fieldName: string;
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
  discriminatorCell,
  onSwitchSheet,
  onStartSelection,
  onExtendSelection,
  onStartResizeField,
  onEndSelection,
}: SpreadsheetViewProps) {
  const tableRef = useRef<HTMLDivElement>(null);
  const isMouseSelectingRef = useRef(false);
  const dragStartPosRef = useRef<{ x: number; y: number } | null>(null);
  const dragThresholdPassedRef = useRef(false);

  const visibleRows = Math.min(sheetData.rows, MAX_VISIBLE_ROWS);
  const visibleCols = Math.min(sheetData.cols, MAX_VISIBLE_COLS);

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
      if (!discriminatorCell) return false;
      const ref = `${colIndexToLetter(col)}${row + 1}`;
      return ref === discriminatorCell;
    },
    [discriminatorCell],
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
              {Array.from({ length: visibleCols }, (_, c) => (
                <th
                  key={c}
                  className="bg-gray-800 border border-gray-700 px-2 py-1 text-gray-400 font-mono font-normal min-w-[80px]"
                >
                  {colIndexToLetter(c)}
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
                {Array.from({ length: visibleCols }, (_, c) => {
                  const inSelection = isInSelection(c, r);
                  const isDisc = isDiscriminator(c, r);
                  const fieldName = getFieldForCell(c, r);
                  const resizeRegion = getResizeRegionForCell(c, r);
                  const cellInfo = sheetData.cells[r]?.[c];
                  const value = cellInfo?.value ?? null;
                  const cellStyle = cellInfo?.style;

                  let cellClass =
                    'px-2 py-1 font-mono whitespace-nowrap cursor-cell ';

                  if (isDisc) {
                    cellClass += 'bg-amber-500/20 border border-amber-500/50 ';
                  } else if (fieldName) {
                    cellClass += 'bg-cyan-500/20 border border-cyan-500/35 ';
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
                      className={`${cellClass} relative`}
                      style={styleToCSS(cellStyle)}
                      onMouseDown={(event) => handleMouseDown(c, r, event)}
                      onMouseEnter={(event) => handleMouseEnter(c, r, event)}
                      title={fieldName ? `Field: ${fieldName}` : undefined}
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
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Sheet tabs */}
      <div className="flex border-t border-gray-700 bg-gray-900">
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
      </div>
    </div>
  );
}
