import { useCallback, useRef, useMemo } from 'react';
import type { SheetData, CellValue, CellStyle } from '../lib/excel';
import type { CellAddress, Selection, StencilField } from '../lib/types';
import { colIndexToLetter, normalizeRange } from '../lib/addressing';

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
  onEndSelection: () => void;
}

const MAX_VISIBLE_ROWS = 200;
const MAX_VISIBLE_COLS = 50;

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
  if (style.fontColor) css.color = style.fontColor;
  if (style.bgColor) css.backgroundColor = style.bgColor;
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
  onEndSelection,
}: SpreadsheetViewProps) {
  const tableRef = useRef<HTMLDivElement>(null);

  const visibleRows = Math.min(sheetData.rows, MAX_VISIBLE_ROWS);
  const visibleCols = Math.min(sheetData.cols, MAX_VISIBLE_COLS);

  const normalizedSelection = useMemo(() => {
    if (!selection) return null;
    return normalizeRange(selection.start, selection.end);
  }, [selection]);

  const fieldCells = useMemo(() => {
    const cells = new Map<string, string>();
    for (const field of fields) {
      if (field.cell) {
        cells.set(field.cell, field.name);
      }
    }
    return cells;
  }, [fields]);

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
      return fieldCells.get(ref);
    },
    [fieldCells],
  );

  const handleMouseDown = useCallback(
    (col: number, row: number) => {
      onStartSelection({ col, row });
    },
    [onStartSelection],
  );

  const handleMouseEnter = useCallback(
    (col: number, row: number) => {
      onExtendSelection({ col, row });
    },
    [onExtendSelection],
  );

  const handleMouseUp = useCallback(() => {
    onEndSelection();
  }, [onEndSelection]);

  return (
    <div className="flex flex-col h-full">
      {/* Spreadsheet grid */}
      <div
        ref={tableRef}
        className="flex-1 overflow-auto"
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
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
                  const cellInfo = sheetData.cells[r]?.[c];
                  const value = cellInfo?.value ?? null;
                  const cellStyle = cellInfo?.style;

                  let cellClass =
                    'px-2 py-1 font-mono whitespace-nowrap cursor-cell ';

                  if (isDisc) {
                    cellClass += 'bg-amber-500/20 border border-amber-500/50 ';
                  } else if (fieldName) {
                    cellClass += 'bg-emerald-500/15 border border-emerald-500/40 ';
                  } else if (inSelection) {
                    cellClass += 'bg-blue-500/20 border border-blue-400/50 ';
                  } else if (!cellStyle?.bgColor) {
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
                      className={cellClass}
                      style={styleToCSS(cellStyle)}
                      onMouseDown={() => handleMouseDown(c, r)}
                      onMouseEnter={() => handleMouseEnter(c, r)}
                      title={fieldName ? `Field: ${fieldName}` : undefined}
                    >
                      {formatCellDisplay(value)}
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
