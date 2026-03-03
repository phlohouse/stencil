import * as XLSX from 'xlsx';

export type CellValue = string | number | boolean | null;

export interface SheetData {
  name: string;
  data: CellValue[][];
  rows: number;
  cols: number;
}

export function parseWorkbook(buffer: ArrayBuffer): XLSX.WorkBook {
  return XLSX.read(buffer, { type: 'array' });
}

export function getSheetNames(workbook: XLSX.WorkBook): string[] {
  return workbook.SheetNames;
}

export function getSheetData(workbook: XLSX.WorkBook, sheetName: string): SheetData {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error(`Sheet "${sheetName}" not found`);

  const range = XLSX.utils.decode_range(sheet['!ref'] ?? 'A1');
  const rows = range.e.r - range.s.r + 1;
  const cols = range.e.c - range.s.c + 1;

  const data: CellValue[][] = [];

  for (let r = range.s.r; r <= range.e.r; r++) {
    const row: CellValue[] = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = sheet[addr];
      if (cell) {
        if (cell.t === 'n') row.push(cell.v as number);
        else if (cell.t === 'b') row.push(cell.v as boolean);
        else if (cell.t === 's') row.push(cell.v as string);
        else if (cell.w) row.push(cell.w);
        else row.push(cell.v != null ? String(cell.v) : null);
      } else {
        row.push(null);
      }
    }
    data.push(row);
  }

  return { name: sheetName, data, rows, cols };
}

export function getCellValue(
  workbook: XLSX.WorkBook,
  sheetName: string,
  address: string,
): CellValue {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return null;
  const cell = sheet[address];
  if (!cell) return null;
  return cell.v as CellValue;
}
