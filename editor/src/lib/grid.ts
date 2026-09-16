import type { SheetData } from './excel';

/** Fixed row height for the virtualised grid, in CSS pixels. */
export const ROW_HEIGHT = 24;
export const HEADER_HEIGHT = 28;
export const GUTTER_WIDTH = 44;
export const DEFAULT_COL_WIDTH = 120;
export const MIN_COL_WIDTH = 96;
export const MAX_COL_WIDTH = 420;

export interface GridGeometry {
  rowHeight: number;
  headerHeight: number;
  gutterWidth: number;
  colWidths: number[];
  /** `colOffsets[i]` is the left edge of column `i`; the last entry is the total width. */
  colOffsets: number[];
  rows: number;
  cols: number;
  totalWidth: number;
  totalHeight: number;
}

export function clampColWidth(width: number | undefined): number {
  if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0) {
    return DEFAULT_COL_WIDTH;
  }
  return Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, Math.round(width)));
}

export function buildGridGeometry(
  sheetData: SheetData,
  options: {
    includeHiddenCols?: boolean;
    rowHeight?: number;
    headerHeight?: number;
    /** Widths the reader has dragged, by column index. */
    colWidthOverrides?: Record<number, number>;
  } = {},
): GridGeometry {
  const cols = Math.max(0, sheetData.cols);
  const rows = Math.max(0, sheetData.rows);
  const colWidths = Array.from({ length: cols }, (_, col) => {
    if (!options.includeHiddenCols && sheetData.hiddenCols?.[col]) return 0;
    const override = options.colWidthOverrides?.[col];
    if (typeof override === 'number') return clampColWidth(override);
    return clampColWidth(sheetData.colWidths?.[col]);
  });

  const colOffsets: number[] = [0];
  for (const width of colWidths) {
    colOffsets.push(colOffsets[colOffsets.length - 1] + width);
  }

  // The first paint uses the defaults; the view then measures the real rendered
  // row and header heights so overlay geometry cannot drift.
  const rowHeight = options.rowHeight && options.rowHeight > 0 ? options.rowHeight : ROW_HEIGHT;
  const headerHeight = options.headerHeight && options.headerHeight > 0 ? options.headerHeight : HEADER_HEIGHT;

  return {
    rowHeight,
    headerHeight,
    gutterWidth: GUTTER_WIDTH,
    colWidths,
    colOffsets,
    rows,
    cols,
    totalWidth: GUTTER_WIDTH + (colOffsets[colOffsets.length - 1] ?? 0),
    totalHeight: headerHeight + rows * rowHeight,
  };
}

/** The selected range as tab separated text, the shape spreadsheets paste. */
export function selectionToTsv(
  sheetData: SheetData,
  start: { col: number; row: number },
  end: { col: number; row: number },
): string {
  const firstRow = Math.max(0, Math.min(start.row, end.row));
  const lastRow = Math.min(sheetData.rows - 1, Math.max(start.row, end.row));
  const firstCol = Math.max(0, Math.min(start.col, end.col));
  const lastCol = Math.min(sheetData.cols - 1, Math.max(start.col, end.col));
  if (lastRow < firstRow || lastCol < firstCol) return '';

  const lines: string[] = [];
  for (let row = firstRow; row <= lastRow; row += 1) {
    const cells: string[] = [];
    for (let col = firstCol; col <= lastCol; col += 1) {
      const value = sheetData.data[row]?.[col];
      cells.push(value === null || value === undefined ? '' : String(value));
    }
    lines.push(cells.join('\t'));
  }
  return lines.join('\n');
}

export interface CellRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface MergeInfoLike {
  isAnchor: boolean;
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export interface MergeExtent {
  rowSpan: number;
  colSpan: number;
  /** False when the cell is covered by a merge anchored earlier in the window. */
  visible: boolean;
}

/**
 * How much of a merged region to draw for one cell, clipped to the rendered
 * window. Covered cells report `visible: false` so the caller skips them, and
 * the spans count hidden columns because they still occupy a column slot.
 */
export function mergeExtent(
  merge: MergeInfoLike | undefined,
  window: GridWindow,
): MergeExtent {
  if (!merge) return { rowSpan: 1, colSpan: 1, visible: true };

  const top = Math.max(merge.top, window.firstRow);
  const left = Math.max(merge.left, window.firstCol);
  const bottom = Math.min(merge.bottom, window.lastRow);
  const right = Math.min(merge.right, window.lastCol);

  return {
    rowSpan: Math.max(1, bottom - top + 1),
    colSpan: Math.max(1, right - left + 1),
    visible: true,
  };
}

/** Whether a cell starts the visible part of its merged region. */
export function isMergeStart(
  merge: MergeInfoLike | undefined,
  window: GridWindow,
  col: number,
  row: number,
): boolean {
  if (!merge) return true;
  return row === Math.max(merge.top, window.firstRow) && col === Math.max(merge.left, window.firstCol);
}

/** Rect of a cell (or a region, when `endCol`/`endRow` are supplied) in grid coordinates. */
export function cellRect(
  geometry: GridGeometry,
  col: number,
  row: number,
  endCol: number = col,
  endRow: number = row,
): CellRect {
  const safeCol = Math.max(0, Math.min(col, Math.max(0, geometry.cols - 1)));
  const safeRow = Math.max(0, Math.min(row, Math.max(0, geometry.rows - 1)));
  const safeEndCol = Math.max(safeCol, Math.min(endCol, Math.max(0, geometry.cols - 1)));
  const safeEndRow = Math.max(safeRow, Math.min(endRow, Math.max(0, geometry.rows - 1)));

  const left = geometry.gutterWidth + geometry.colOffsets[safeCol];
  const right = geometry.gutterWidth + geometry.colOffsets[safeEndCol + 1];

  return {
    top: geometry.headerHeight + safeRow * geometry.rowHeight,
    left,
    width: right - left,
    height: (safeEndRow - safeRow + 1) * geometry.rowHeight,
  };
}

export interface GridWindow {
  firstRow: number;
  lastRow: number;
  firstCol: number;
  lastCol: number;
}

/** Index of the column containing `offset` (grid coordinates, excluding the gutter). */
export function colAtOffset(geometry: GridGeometry, offset: number): number {
  const { colOffsets, cols } = geometry;
  if (cols === 0) return 0;
  let low = 0;
  let high = cols - 1;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if (colOffsets[mid] <= offset) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}

/**
 * The slice of rows/columns that must be rendered for a scroll viewport, with a
 * small overscan so scrolling does not reveal empty cells.
 */
export function visibleWindow(
  geometry: GridGeometry,
  viewport: { scrollTop: number; scrollLeft: number; width: number; height: number },
  overscanRows = 4,
  overscanCols = 2,
): GridWindow {
  const { rows, cols, rowHeight, headerHeight, gutterWidth } = geometry;
  if (rows === 0 || cols === 0) {
    return { firstRow: 0, lastRow: -1, firstCol: 0, lastCol: -1 };
  }

  const bodyTop = Math.max(0, viewport.scrollTop - headerHeight);
  const bodyBottom = Math.max(0, viewport.scrollTop + viewport.height - headerHeight);

  const firstRow = Math.max(0, Math.floor(bodyTop / rowHeight) - overscanRows);
  const lastRow = Math.min(rows - 1, Math.floor(bodyBottom / rowHeight) + overscanRows);

  const bodyLeft = Math.max(0, viewport.scrollLeft - gutterWidth);
  const bodyRight = Math.max(0, viewport.scrollLeft + viewport.width - gutterWidth);

  const firstCol = Math.max(0, colAtOffset(geometry, bodyLeft) - overscanCols);
  const lastCol = Math.min(cols - 1, colAtOffset(geometry, bodyRight) + overscanCols);

  return { firstRow, lastRow, firstCol, lastCol };
}
