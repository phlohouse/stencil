import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { scanWorkbookForSuggestions, type TableSuggestion, type FieldSuggestion } from './suggestions';

type CellSpec = string | number | null;

interface BuildOptions {
  sheetName?: string;
  merges?: string[];
  boldRows?: number[];
}

function buildWorkbook(rows: CellSpec[][], options: BuildOptions = {}): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(options.sheetName ?? 'Sheet1');

  rows.forEach((row, rowIndex) => {
    row.forEach((value, colIndex) => {
      if (value === null || value === undefined) return;
      sheet.getCell(rowIndex + 1, colIndex + 1).value = value;
    });
  });

  for (const merge of options.merges ?? []) {
    sheet.mergeCells(merge);
  }
  for (const row of options.boldRows ?? []) {
    for (let col = 1; col <= sheet.columnCount; col += 1) {
      sheet.getCell(row, col).font = { bold: true };
    }
  }

  return workbook;
}

function tablesOf(workbook: ExcelJS.Workbook): TableSuggestion[] {
  return scanWorkbookForSuggestions(workbook).filter(
    (suggestion): suggestion is TableSuggestion => suggestion.kind === 'table',
  );
}

function fieldsOf(workbook: ExcelJS.Workbook): FieldSuggestion[] {
  return scanWorkbookForSuggestions(workbook).filter(
    (suggestion): suggestion is FieldSuggestion => suggestion.kind === 'field',
  );
}

describe('scanWorkbookForSuggestions: table detection', () => {
  it('suggests a table for a plain header row', () => {
    const tables = tablesOf(buildWorkbook([
      ['Sample ID', 'Assay', 'Result', 'Units'],
      ['S-001', 'Hb', 12.4, 'g/dL'],
      ['S-002', 'Hb', 13.1, 'g/dL'],
      ['S-003', 'WBC', 6.2, '10^9/L'],
    ]));

    expect(tables).toHaveLength(1);
    expect(tables[0].targetRef).toBe('A1:D');
    expect(tables[0].headers).toEqual(['Sample ID', 'Assay', 'Result', 'Units']);
    expect(tables[0].field.columns).toEqual({
      A: 'sample_id',
      B: 'assay',
      C: 'result',
      D: 'units',
    });
  });

  it('does not turn a key/value block into a table', () => {
    const workbook = buildWorkbook([
      ['Report ID', 'RPT-2291'],
      ['Operator', 'jsmith'],
      ['Instrument', 'AU5800'],
      ['Run date', '2024-03-11'],
      ['Run time', '08:14'],
      ['Status', 'Final'],
    ]);

    expect(tablesOf(workbook)).toHaveLength(0);

    const fields = fieldsOf(workbook);
    expect(fields.map((field) => field.field.name)).toContain('report_id');
    expect(fields.find((field) => field.field.name === 'report_id')?.targetRef).toBe('B1');
    expect(fields.find((field) => field.field.name === 'run_date')?.targetRef).toBe('B4');
  });

  it('suggests one field per key/value pair, even when the value is a name', () => {
    const fields = fieldsOf(buildWorkbook([
      ['Report ID', 'RPT-2291'],
      ['Operator', 'jsmith'],
      ['Instrument', 'AU5800'],
      ['Run date', '2024-03-11'],
      ['Run time', '08:14'],
      ['Status', 'Final'],
    ]));

    const byName = Object.fromEntries(fields.map((field) => [field.field.name, field.targetRef]));
    expect(byName).toMatchObject({
      report_id: 'B1',
      operator: 'B2',
      instrument: 'B3',
      run_date: 'B4',
      run_time: 'B5',
      status: 'B6',
    });
    expect(tablesOf(buildWorkbook([
      ['Operator', 'jsmith'],
      ['Reviewer', 'mchen'],
      ['Site', 'North'],
    ]))).toHaveLength(0);
  });

  it('suggests one field per column for a cover block', () => {
    const workbook = buildWorkbook([
      ['Report ID', 'Operator', 'Date', 'Status'],
      ['RPT-2291', 'jsmith', '2024-03-11', 'Final'],
    ]);

    const fields = fieldsOf(workbook);
    const byName = Object.fromEntries(fields.map((field) => [field.field.name, field.targetRef]));
    expect(byName).toMatchObject({
      report_id: 'A2',
      operator: 'B2',
      date: 'C2',
      status: 'D2',
    });
    expect(byName).not.toHaveProperty('jsmith');
    expect(tablesOf(workbook)).toHaveLength(0);
  });

  it('uses a merged header cell as the column name when data sits underneath', () => {
    const workbook = buildWorkbook([
      ['Sample ID', 'Result', null, 'Units'],
      ['S-001', 12.4, 3.1, 'g/dL'],
      ['S-002', 13.1, 3.4, 'g/dL'],
      ['S-003', 6.2, 2.9, '10^9/L'],
    ], { merges: ['B1:C1'] });

    const tables = tablesOf(workbook);
    expect(tables).toHaveLength(1);
    expect(tables[0].targetRef).toBe('A1:D');
    expect(tables[0].field.columns).toEqual({
      A: 'sample_id',
      B: 'result',
      C: 'result_2',
      D: 'units',
    });
  });

  it('uses the sub header row under repeated group labels', () => {
    const tables = tablesOf(buildWorkbook([
      [null, 'Haematology', 'Haematology', 'Chemistry', 'Chemistry'],
      ['Sample ID', 'Hb', 'WBC', 'Na', 'K'],
      ['S-001', 12.4, 6.2, 140, 4.1],
      ['S-002', 13.1, 7.0, 138, 4.3],
      ['S-003', 11.8, 5.9, 141, 3.9],
    ]));

    expect(tables).toHaveLength(1);
    expect(tables[0].targetRef).toBe('A2:E');
    expect(tables[0].headers).toEqual(['Sample ID', 'Hb', 'WBC', 'Na', 'K']);
    expect(tables[0].field.columns).toMatchObject({ A: 'sample_id', B: 'hb', D: 'na', E: 'k' });
  });

  it('suggests tables whose column headers are years in order', () => {
    const tables = tablesOf(buildWorkbook([
      ['Site', 2021, 2022, 2023, 2024],
      ['North', 12, 14, 9, 11],
      ['South', 7, 8, 6, 10],
      ['East', 3, 5, 4, 4],
    ]));

    expect(tables).toHaveLength(1);
    expect(tables[0].targetRef).toBe('A1:E');
    expect(tables[0].field.columns).toMatchObject({ B: '2021', E: '2024' });
  });

  it('does not treat a data row of years as a header row', () => {
    const tables = tablesOf(buildWorkbook([
      ['Metric', 'North', 'South'],
      ['Samples', 2021, 2022],
      ['Rate', 2023, 2024],
    ]));

    expect(tables.map((table) => table.targetRef)).toEqual(['A1:C']);
  });

  it('suggests key/value pairs when the value sits to the left of the label', () => {
    const fields = fieldsOf(buildWorkbook([
      ['RPT-2291', 'Report ID'],
      ['jsmith', 'Operator'],
      ['2024-03-11', 'Date'],
    ]));

    const byName = Object.fromEntries(fields.map((field) => [field.field.name, field.targetRef]));
    expect(byName).toMatchObject({ report_id: 'A1', operator: 'A2', date: 'A3' });
  });

  it('does not read table rows as key/value pairs', () => {
    const workbook = buildWorkbook([
      ['Site', 'Count', 'Rate'],
      ['North', 120, 0.12],
      ['South', 98, 0.09],
      ['East', 44, 0.05],
    ]);

    expect(tablesOf(workbook).map((table) => table.targetRef)).toEqual(['A1:C']);
    const names = fieldsOf(workbook).map((field) => field.field.name);
    expect(names).not.toContain('north');
    expect(names).not.toContain('south');
  });

  it('keeps a metadata block above the real table out of the suggestions', () => {
    const tables = tablesOf(buildWorkbook([
      ['Report ID', 'RPT-2291', null, null],
      ['Operator', 'jsmith', null, null],
      ['Date', '2024-03-11', null, null],
      [null, null, null, null],
      ['Sample ID', 'Assay', 'Result', 'Units'],
      ['S-001', 'Hb', 12.4, 'g/dL'],
      ['S-002', 'Hb', 13.1, 'g/dL'],
    ]));

    expect(tables).toHaveLength(1);
    expect(tables[0].targetRef).toBe('A5:D');
  });

  it('ignores a merged section band above the header row', () => {
    const workbook = buildWorkbook([
      ['Results', null, null, null],
      ['Sample ID', 'Assay', 'Result', 'Units'],
      ['S-001', 'Hb', 12.4, 'g/dL'],
      ['S-002', 'Hb', 13.1, 'g/dL'],
      ['S-003', 'WBC', 6.2, '10^9/L'],
    ], { merges: ['A1:D1'] });

    const tables = tablesOf(workbook);
    expect(tables).toHaveLength(1);
    expect(tables[0].targetRef).toBe('A2:D');
    expect(fieldsOf(workbook).map((field) => field.field.name)).not.toContain('results');
  });

  it('skips a merged group header row and uses the row below it', () => {
    const workbook = buildWorkbook([
      [null, 'Haematology', null, null],
      ['Sample ID', 'Value', 'Units', 'Flag'],
      ['S-001', 12.4, 'g/dL', 'N'],
      ['S-002', 6.2, '10^9/L', 'H'],
      ['S-003', 245, '10^9/L', 'N'],
    ], { merges: ['B1:C1'] });

    const tables = tablesOf(workbook);
    expect(tables).toHaveLength(1);
    expect(tables[0].targetRef).toBe('A2:D');
    expect(tables[0].headers).toEqual(['Sample ID', 'Value', 'Units', 'Flag']);
  });

  it('does not treat a data row of an all-string table as a header row', () => {
    const tables = tablesOf(buildWorkbook([
      ['Site', 'Region', 'Manager', 'Status'],
      ['North', 'EMEA', 'Alice', 'Active'],
      ['South', 'EMEA', 'Ben', 'Active'],
      ['East', 'APAC', 'Chen', 'Paused'],
      ['West', 'AMER', 'Dana', 'Active'],
    ]));

    expect(tables).toHaveLength(1);
    expect(tables[0].targetRef).toBe('A1:D');
  });

  it('keeps an all-string table that sits under a merged title band', () => {
    const workbook = buildWorkbook([
      ['Site summary', null, null, null],
      ['Site', 'Region', 'Manager', 'Status'],
      ['North', 'EMEA', 'Alice', 'Active'],
      ['South', 'EMEA', 'Ben', 'Active'],
      ['East', 'APAC', 'Chen', 'Paused'],
    ], { merges: ['A1:D1'] });

    const tables = tablesOf(workbook);
    expect(tables).toHaveLength(1);
    expect(tables[0].targetRef).toBe('A2:D');
  });

  it('keeps duplicate header names distinct', () => {
    const tables = tablesOf(buildWorkbook([
      ['Sample ID', 'Result', 'Result', 'Flag'],
      ['S-001', 12.4, 3.1, 'N'],
      ['S-002', 13.1, 3.4, 'N'],
      ['S-003', 6.2, 2.9, 'H'],
    ]));

    expect(tables).toHaveLength(1);
    expect(tables[0].field.columns).toEqual({
      A: 'sample_id',
      B: 'result',
      C: 'result_2',
      D: 'flag',
    });
  });

  it('suggests tables whose column headers are typed values', () => {
    const tables = tablesOf(buildWorkbook([
      ['Site', '2024-01-01', '2024-01-02', '2024-01-03'],
      ['North', 12, 14, 9],
      ['South', 7, 8, 6],
      ['East', 3, 5, 4],
    ]));

    expect(tables).toHaveLength(1);
    expect(tables[0].targetRef).toBe('A1:D');
    expect(tables[0].field.columns).toMatchObject({ B: '2024_01_01', D: '2024_01_03' });
  });

  it('keeps a table together across a spacer row', () => {
    const tables = tablesOf(buildWorkbook([
      ['Sample ID', 'Assay', 'Result', 'Units'],
      ['S-001', 'Hb', 12.4, 'g/dL'],
      ['S-002', 'Hb', 13.1, 'g/dL'],
      [null, null, null, null],
      ['S-003', 'WBC', 6.2, '10^9/L'],
      ['S-004', 'WBC', 7.0, '10^9/L'],
    ]));

    expect(tables).toHaveLength(1);
    expect(tables[0].targetRef).toBe('A1:D');
    expect(tables[0].score).toBeGreaterThan(0.85);
  });

  it('finds two tables stacked on one sheet', () => {
    const tables = tablesOf(buildWorkbook([
      ['Sample ID', 'Assay', 'Result'],
      ['S-001', 'Hb', 12.4],
      ['S-002', 'Hb', 13.1],
      [null, null, null],
      ['Site', 'Count', 'Rate'],
      ['North', 120, 0.12],
      ['South', 98, 0.09],
    ]));

    expect(tables.map((table) => table.targetRef).sort()).toEqual(['A1:C', 'A5:C']);
  });

  it('keeps a two-column table', () => {
    const tables = tablesOf(buildWorkbook([
      ['Site', 'Count'],
      ['North', 120],
      ['South', 98],
      ['East', 44],
    ]));

    expect(tables).toHaveLength(1);
    expect(tables[0].targetRef).toBe('A1:B');
  });

  it('aligns column letters when the header row contains a spacer column', () => {
    const tables = tablesOf(buildWorkbook([
      ['Sample ID', null, 'Result', 'Units'],
      ['S-001', null, 12.4, 'g/dL'],
      ['S-002', null, 13.1, 'g/dL'],
      ['S-003', null, 6.2, '10^9/L'],
    ]));

    expect(tables).toHaveLength(1);
    expect(tables[0].field.columns).toEqual({
      A: 'sample_id',
      C: 'result',
      D: 'units',
    });
  });

  it('aligns column letters for titled tables that contain a spacer column', () => {
    const tables = tablesOf(buildWorkbook([
      ['Table 1: Results', null, null, null],
      ['Sample ID', null, 'Result', 'Units'],
      ['S-001', null, 12.4, 'g/dL'],
      ['S-002', null, 13.1, 'g/dL'],
      ['S-003', null, 6.2, '10^9/L'],
    ]));

    expect(tables).toHaveLength(1);
    expect(tables[0].targetRef).toBe('A2:D');
    expect(tables[0].field.columns).toEqual({
      A: 'sample_id',
      C: 'result',
      D: 'units',
    });
  });

  it('gives tables that would share a name distinct names', () => {
    const tables = tablesOf(buildWorkbook([
      ['Sample ID', 'Assay', 'Result'],
      ['S-001', 'Hb', 12.4],
      ['S-002', 'Hb', 13.1],
      [null, null, null],
      ['Sample ID', 'Assay', 'Result'],
      ['S-101', 'WBC', 6.2],
      ['S-102', 'WBC', 7.0],
    ]));

    expect(tables.map((table) => table.targetRef).sort()).toEqual(['A1:C', 'A5:C']);
    const names = tables.map((table) => table.field.name).sort();
    expect(names).toEqual(['sample_id_table', 'sample_id_table_2']);
  });

  it('scans a large sheet quickly', () => {
    const rows: CellSpec[][] = [['Sample ID', 'Assay', 'Result', 'Units', 'Flag', 'Site']];
    for (let index = 0; index < 3000; index += 1) {
      rows.push([`S-${index}`, 'Hb', 12.4, 'g/dL', 'N', 'North']);
    }

    const workbook = buildWorkbook(rows);
    const started = Date.now();
    const tables = tablesOf(workbook);
    const elapsed = Date.now() - started;

    expect(tables[0]?.targetRef).toBe('A1:F');
    expect(elapsed).toBeLessThan(2000);
  });
});
