// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SpreadsheetView } from './SpreadsheetView';
import type { StencilField } from '../lib/types';
import type { SheetData } from '../lib/excel';

function sheet(): SheetData {
  return {
    name: 'Sheet1', rows: 5, cols: 4, hiddenCols: [], colWidths: [],
    data: Array.from({ length: 5 }, () => ['label', 'Assay', 'Lower', 'Upper']),
    cells: Array.from({ length: 5 }, () => ['label', 'Assay', 'Lower', 'Upper'].map((value) => ({ value }))),
  };
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function show(fields: StencilField[], sheetData = sheet()) {
  render(<SpreadsheetView
    sheetData={sheetData} sheetNames={['Sheet1']} activeSheet="Sheet1"
    fields={fields} activeFieldName={null} selection={null} showHiddenColumns={false}
    onSetSelection={vi.fn()} onEndSelection={vi.fn()} onClearSelection={vi.fn()}
    onSelectField={vi.fn()} onEditField={vi.fn()} onDeleteField={vi.fn()}
  />);
}

describe('table mappings on header hover', () => {
  it('shows mappings on the workbook headers above explicit table data without selecting a table', () => {
    show([{ name: 'results', range: 'B2:D5', type: 'table', columns: { B: 'assay', C: 'slope_lower', D: 'slope_upper' } }]);
    expect(screen.getByTitle(/results: B → assay/).getAttribute('data-cell-ref')).toBe('B1');
    expect(screen.getByTitle(/results: C → slope_lower/).getAttribute('data-cell-ref')).toBe('C1');
    expect(screen.getByTitle(/results: D → slope_upper/).getAttribute('data-cell-ref')).toBe('D1');
    expect(screen.queryByRole('region', { name: 'Mappings for results' })).toBeNull();
    expect(document.querySelector('[data-cell-ref="C2"]')?.getAttribute('title')).toBe('Field: results\nValue: Lower');
  });

  it('shows vertical mappings on the label cells in the first table column', () => {
    show([{ name: 'plates', range: 'A2:D3', type: 'table', tableOrientation: 'vertical', columns: { 2: 'extraction_id', 3: 'barcode' } }]);
    expect(screen.getByTitle(/plates: 2 → extraction_id/).getAttribute('data-cell-ref')).toBe('A2');
    expect(screen.getByTitle(/plates: 3 → barcode/).getAttribute('data-cell-ref')).toBe('A3');
  });

  it('combines mappings under a merged workbook header', () => {
    const data = sheet();
    for (const col of [1, 2]) {
      data.cells[0][col].merge = { isAnchor: col === 1, top: 0, left: 1, bottom: 0, right: 2 };
    }
    show([{ name: 'results', range: 'B2:C5', type: 'table', columns: { B: 'assay', C: 'slope' } }], data);
    expect(screen.getByTitle(/results: B → assay/).getAttribute('title')).toBe('Assay\nresults: B → assay\nresults: C → slope');
  });

  it('does not invent header mappings for another sheet or an explicit range starting at row one', () => {
    show([
      { name: 'elsewhere', range: 'Other!B2:D5', type: 'table', columns: { B: 'assay' } },
      { name: 'no_header', range: 'B1:D5', type: 'table', columns: { B: 'assay' } },
    ]);
    expect(screen.queryByTitle(/→/)).toBeNull();
  });
});
