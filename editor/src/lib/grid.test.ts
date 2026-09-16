import { describe, expect, it } from 'vitest';
import {
  buildGridGeometry,
  cellRect,
  clampColWidth,
  selectionToTsv,
  colAtOffset,
  isMergeStart,
  mergeExtent,
  visibleWindow,
  DEFAULT_COL_WIDTH,
  GUTTER_WIDTH,
  HEADER_HEIGHT,
  MAX_COL_WIDTH,
  MIN_COL_WIDTH,
  ROW_HEIGHT,
  type GridWindow,
} from './grid';
import type { CellInfo, SheetData } from './excel';

function sheet(rows: number, cols: number, colWidths: number[] = []): SheetData {
  const data = Array.from({ length: rows }, () => Array.from({ length: cols }, () => null));
  const cells: CellInfo[][] = data.map((row) => row.map((value) => ({ value })));
  return {
    name: 'Sheet1',
    data,
    cells,
    rows,
    cols,
    hiddenCols: [],
    colWidths,
  };
}

describe('clampColWidth', () => {
  it('falls back to the default for missing widths', () => {
    expect(clampColWidth(undefined)).toBe(DEFAULT_COL_WIDTH);
    expect(clampColWidth(0)).toBe(DEFAULT_COL_WIDTH);
  });

  it('clamps to a readable range', () => {
    expect(clampColWidth(10)).toBe(MIN_COL_WIDTH);
    expect(clampColWidth(10_000)).toBe(MAX_COL_WIDTH);
    expect(clampColWidth(150)).toBe(150);
  });
});

describe('buildGridGeometry', () => {
  it('lays out columns after the gutter', () => {
    const geometry = buildGridGeometry(sheet(10, 3, [100, 200, 300]));
    expect(geometry.colWidths).toEqual([100, 200, 300]);
    expect(geometry.colOffsets).toEqual([0, 100, 300, 600]);
    expect(geometry.totalWidth).toBe(GUTTER_WIDTH + 600);
    expect(geometry.totalHeight).toBe(HEADER_HEIGHT + 10 * ROW_HEIGHT);
  });

  it('uses the default width for columns the workbook does not size', () => {
    const geometry = buildGridGeometry(sheet(2, 2));
    expect(geometry.colWidths).toEqual([DEFAULT_COL_WIDTH, DEFAULT_COL_WIDTH]);
  });
});

describe('mergeExtent', () => {
  const window: GridWindow = { firstRow: 2, lastRow: 8, firstCol: 1, lastCol: 6 };

  it('returns a plain cell when there is no merge', () => {
    expect(mergeExtent(undefined, window)).toEqual({ rowSpan: 1, colSpan: 1, visible: true });
  });

  it('spans a merge that sits inside the window', () => {
    const merge = { isAnchor: true, top: 3, left: 2, bottom: 5, right: 4 };
    expect(mergeExtent(merge, window)).toEqual({ rowSpan: 3, colSpan: 3, visible: true });
    expect(isMergeStart(merge, window, 2, 3)).toBe(true);
    expect(isMergeStart(merge, window, 3, 3)).toBe(false);
    expect(isMergeStart(merge, window, 2, 4)).toBe(false);
  });

  it('clips a merge that starts before the window', () => {
    const merge = { isAnchor: true, top: 0, left: 0, bottom: 4, right: 3 };
    expect(mergeExtent(merge, window)).toEqual({ rowSpan: 3, colSpan: 3, visible: true });
    // The visible part starts at the window origin, not at the real anchor.
    expect(isMergeStart(merge, window, 1, 2)).toBe(true);
    expect(isMergeStart(merge, window, 0, 2)).toBe(false);
  });

  it('counts hidden columns inside the span', () => {
    // C..G merged (5 slots) even though two of those columns may be hidden.
    const merge = { isAnchor: true, top: 1, left: 2, bottom: 1, right: 6 };
    expect(mergeExtent(merge, { firstRow: 0, lastRow: 10, firstCol: 0, lastCol: 9 }).colSpan).toBe(5);
  });

  it('never reports a zero span', () => {
    const merge = { isAnchor: true, top: 0, left: 0, bottom: 0, right: 0 };
    expect(mergeExtent(merge, window)).toEqual({ rowSpan: 1, colSpan: 1, visible: true });
  });
});

describe('cellRect', () => {
  const geometry = buildGridGeometry(sheet(100, 4, [100, 100, 100, 100]));

  it('positions a single cell', () => {
    expect(cellRect(geometry, 2, 3)).toEqual({
      top: HEADER_HEIGHT + 3 * ROW_HEIGHT,
      left: GUTTER_WIDTH + 200,
      width: 100,
      height: ROW_HEIGHT,
    });
  });

  it('spans regions', () => {
    const rect = cellRect(geometry, 1, 2, 3, 5);
    expect(rect.width).toBe(300);
    expect(rect.height).toBe(4 * ROW_HEIGHT);
  });

  it('clamps out-of-range addresses', () => {
    expect(cellRect(geometry, -5, -5).left).toBe(GUTTER_WIDTH);
    const last = cellRect(geometry, 99, 99);
    expect(last.left + last.width).toBe(geometry.totalWidth);
    expect(last.top + last.height).toBe(geometry.totalHeight);
  });
});

describe('colAtOffset', () => {
  const geometry = buildGridGeometry(sheet(5, 4, [100, 96, 200, 100]));

  it('finds the column under an offset', () => {
    expect(colAtOffset(geometry, 0)).toBe(0);
    expect(colAtOffset(geometry, 99)).toBe(0);
    expect(colAtOffset(geometry, 100)).toBe(1);
    expect(colAtOffset(geometry, 195)).toBe(1);
    expect(colAtOffset(geometry, 196)).toBe(2);
    expect(colAtOffset(geometry, 1000)).toBe(3);
  });
});

describe('visibleWindow', () => {
  const geometry = buildGridGeometry(sheet(1000, 60, Array.from({ length: 60 }, () => 100)));

  it('covers the viewport with overscan', () => {
    const window = visibleWindow(geometry, { scrollTop: 0, scrollLeft: 0, width: 500, height: 240 });
    expect(window.firstRow).toBe(0);
    expect(window.lastRow).toBe(Math.floor((240 - HEADER_HEIGHT) / ROW_HEIGHT) + 4);
    expect(window.firstCol).toBe(0);
    expect(window.lastCol).toBeGreaterThanOrEqual(4);
  });

  it('follows the scroll position', () => {
    const window = visibleWindow(geometry, {
      scrollTop: HEADER_HEIGHT + 500 * ROW_HEIGHT,
      scrollLeft: GUTTER_WIDTH + 1000,
      width: 500,
      height: 240,
    });
    expect(window.firstRow).toBe(496);
    expect(window.lastRow).toBeGreaterThan(500);
    expect(window.firstCol).toBe(8);
  });

  it('never renders rows or columns outside the grid', () => {
    const window = visibleWindow(geometry, { scrollTop: 0, scrollLeft: 0, width: 5000, height: 5000 });
    expect(window.lastRow).toBeLessThanOrEqual(999);
    expect(window.lastCol).toBeLessThanOrEqual(59);
    // A viewport taller/wider than the sheet only needs the whole sheet.
    expect(visibleWindow(geometry, {
      scrollTop: 0, scrollLeft: 0, width: 5000, height: 5000,
    }).firstRow).toBe(0);
    expect(visibleWindow(geometry, {
      scrollTop: 0, scrollLeft: 0, width: 100_000, height: 100_000,
    }).lastRow).toBe(999);
  });

  it('handles an empty sheet', () => {
    const empty = buildGridGeometry(sheet(0, 0));
    expect(visibleWindow(empty, { scrollTop: 0, scrollLeft: 0, width: 100, height: 100 }))
      .toEqual({ firstRow: 0, lastRow: -1, firstCol: 0, lastCol: -1 });
  });
});

describe('selectionToTsv', () => {
  const sheetData = {
    name: 'Sheet1',
    rows: 3,
    cols: 3,
    data: [
      ['a', 1, null],
      ['b', 2, true],
      ['c', 3, 'x'],
    ],
    cells: [],
    hiddenCols: [],
    colWidths: [],
  } as unknown as Parameters<typeof selectionToTsv>[0];

  it('copies a range as tab separated text', () => {
    expect(selectionToTsv(sheetData, { row: 0, col: 0 }, { row: 1, col: 1 })).toBe('a\t1\nb\t2');
  });

  it('accepts a selection dragged upwards and writes blanks for empty cells', () => {
    expect(selectionToTsv(sheetData, { row: 2, col: 2 }, { row: 1, col: 1 })).toBe('2\ttrue\n3\tx');
  });

  it('copies a single cell', () => {
    expect(selectionToTsv(sheetData, { row: 0, col: 0 }, { row: 0, col: 0 })).toBe('a');
  });
});
