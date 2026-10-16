// @vitest-environment jsdom
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ExcelJS from 'exceljs';
import App from './App';
import * as excel from './lib/excel';
import * as storage from './lib/storage';
import * as guard from './lib/file-guard';
import type { StencilField } from './lib/types';

vi.mock('./lib/storage', () => ({
  loadFile: vi.fn(async () => null),
  saveFile: vi.fn(async () => {}),
  saveVersionFile: vi.fn(async () => {}),
  loadVersionFile: vi.fn(async () => null),
}));
vi.mock('./components/SpreadsheetView', () => ({
  SpreadsheetView: ({ fields }: { fields: StencilField[] }) => <div data-testid="ranges">{fields.map((field) => `${field.name}:${field.range ?? field.cell}`).join(',')}</div>,
}));

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '', '/#launch=' + encodeURIComponent('http://127.0.0.1:43210/_stencil/test-token'));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('opening files from the CLI', () => {
  it.each([false, true])('loads the matching inherited fields under StrictMode, large file: %s', async (large) => {
    vi.spyOn(guard, 'isLargeWorkbook').mockReturnValue(large);
    const book = new ExcelJS.Workbook();
    book.addWorksheet('Sheet1').getCell('A1').value = 'new';
    vi.spyOn(excel, 'parseWorkbook').mockResolvedValue(book);
    const yaml = `name: launch
versions:
  old:
    fields:
      patient: {cell: B2}
  new:
    extends: old
    fields:
      results: {range: A10:C20, type: table}
`;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/schema')) return new Response(yaml);
      if (url.endsWith('/file')) return new Response(new Uint8Array([1, 2, 3]));
      return new Response(JSON.stringify({ schema: true, file: 'test.xlsm', version: 'new' }));
    }));
    render(<StrictMode><App /></StrictMode>);
    if (large) {
      const confirm = await screen.findByRole('button', { name: 'Open Workbook' });
      expect(excel.parseWorkbook).not.toHaveBeenCalled();
      fireEvent.click(confirm);
    }
    await waitFor(() => expect(screen.getByTestId('ranges').textContent).toBe('patient:B2,results:A10:C20'));
    expect(storage.loadFile).not.toHaveBeenCalled();
    expect(storage.saveVersionFile).toHaveBeenCalledWith(expect.any(String), 'new', expect.any(ArrayBuffer));
  });

  it('shows a failed handoff in the editor', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    render(<App />);
    await waitFor(() => expect(screen.getByText(/Could not open launch files/)).toBeTruthy());
  });
});
