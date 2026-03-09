import ExcelJS from 'exceljs';

export type CellValue = string | number | boolean | null;

export interface CellStyle {
  bold?: boolean;
  italic?: boolean;
  fontSize?: number;
  fontColor?: string;
  bgColor?: string;
  borderTop?: string;
  borderBottom?: string;
  borderLeft?: string;
  borderRight?: string;
  hAlign?: string;
}

export interface CellInfo {
  value: CellValue;
  style?: CellStyle;
}

export interface SheetData {
  name: string;
  data: CellValue[][];
  cells: CellInfo[][];
  rows: number;
  cols: number;
}

export type Workbook = ExcelJS.Workbook;

export async function parseWorkbook(buffer: ArrayBuffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb;
}

export function getSheetNames(workbook: ExcelJS.Workbook): string[] {
  return workbook.worksheets.map((ws) => ws.name);
}

export function getSheetData(workbook: ExcelJS.Workbook, sheetName: string): SheetData {
  const ws = workbook.getWorksheet(sheetName);
  if (!ws) throw new Error(`Sheet "${sheetName}" not found`);

  const rows = ws.rowCount;
  const cols = ws.columnCount;

  const data: CellValue[][] = [];
  const cells: CellInfo[][] = [];

  for (let r = 1; r <= rows; r++) {
    const row: CellValue[] = [];
    const cellRow: CellInfo[] = [];
    const wsRow = ws.getRow(r);

    for (let c = 1; c <= cols; c++) {
      const cell = wsRow.getCell(c);
      const value = formatValue(cell);
      row.push(value);
      cellRow.push({ value, style: extractStyle(cell) });
    }

    data.push(row);
    cells.push(cellRow);
  }

  return { name: sheetName, data, cells, rows, cols };
}

export function getCellValue(
  workbook: ExcelJS.Workbook,
  sheetName: string,
  address: string,
): CellValue {
  const ws = workbook.getWorksheet(sheetName);
  if (!ws) return null;
  const cell = ws.getCell(address);
  return formatValue(cell);
}

function formatValue(cell: ExcelJS.Cell): CellValue {
  const val = cell.value;
  if (val === null || val === undefined) return null;

  if (typeof val === 'object' && 'error' in val) {
    return val.error;
  }

  // Rich text
  if (typeof val === 'object' && 'richText' in val) {
    return (val as ExcelJS.CellRichTextValue).richText.map((r) => r.text).join('');
  }

  // Formula result
  if (typeof val === 'object' && 'result' in val) {
    const result = (val as ExcelJS.CellFormulaValue).result;
    if (result === null || result === undefined) return null;
    if (typeof result === 'object' && 'error' in result) return String(result.error);
    return formatPrimitive(result, cell);
  }

  if (typeof val === 'object' && ('formula' in val || 'sharedFormula' in val)) {
    const formula = cell.formula;
    return formula ? `=${formula}` : null;
  }

  // Hyperlink
  if (typeof val === 'object' && 'hyperlink' in val) {
    const hyperlinkValue = val as ExcelJS.CellHyperlinkValue;
    return hyperlinkValue.text || hyperlinkValue.hyperlink || null;
  }

  // Date
  if (val instanceof Date) {
    return val.toLocaleDateString();
  }

  if (typeof val === 'object') {
    return cell.text && cell.text !== '[object Object]' ? cell.text : null;
  }

  return formatPrimitive(val, cell);
}

function formatPrimitive(val: unknown, cell: ExcelJS.Cell): CellValue {
  if (val instanceof Date) return val.toLocaleDateString();
  if (typeof val === 'boolean') return val;
  if (typeof val === 'number') {
    // Use numFmt if available for display
    const fmt = cell.numFmt;
    if (fmt && isDateFormat(fmt)) {
      // Excel date serial number
      const date = excelDateToJS(val);
      return date.toLocaleDateString();
    }
    return val;
  }
  if (typeof val === 'string') return val;
  return null;
}

function isDateFormat(fmt: string): boolean {
  // Common date format patterns
  const dateChars = /[dmyDMY]/;
  const notJustNumber = /[^0#.,;%E\s-]/;
  return dateChars.test(fmt) && notJustNumber.test(fmt) && !fmt.includes('[');
}

function excelDateToJS(serial: number): Date {
  // Excel epoch: 1900-01-01, with the 1900 leap year bug
  const epoch = new Date(1899, 11, 30);
  return new Date(epoch.getTime() + serial * 86400000);
}

function resolveColor(color: Partial<ExcelJS.Color> | undefined): string | undefined {
  if (!color) return undefined;
  if (color.argb) {
    const hex = color.argb.length === 8 ? color.argb.slice(2) : color.argb;
    if (hex === '000000' || hex === 'FFFFFF') return undefined;
    return `#${hex}`;
  }
  return undefined;
}

const BORDER_STYLE_MAP: Record<string, string> = {
  thin: '1px solid',
  medium: '2px solid',
  thick: '3px solid',
  dotted: '1px dotted',
  dashed: '1px dashed',
  double: '3px double',
  hair: '1px solid',
  mediumDashed: '2px dashed',
  dashDot: '1px dashed',
  mediumDashDot: '2px dashed',
  dashDotDot: '1px dotted',
  mediumDashDotDot: '2px dotted',
  slantDashDot: '2px dashed',
};

function resolveBorder(border: Partial<ExcelJS.Border> | undefined): string | undefined {
  if (!border?.style) return undefined;
  const width = BORDER_STYLE_MAP[border.style] ?? '1px solid';
  const color = resolveColor(border.color) ?? '#888';
  return `${width} ${color}`;
}

function extractStyle(cell: ExcelJS.Cell): CellStyle | undefined {
  const style: CellStyle = {};
  let hasStyle = false;

  const font = cell.font;
  if (font?.bold) { style.bold = true; hasStyle = true; }
  if (font?.italic) { style.italic = true; hasStyle = true; }
  if (font?.size) { style.fontSize = font.size; hasStyle = true; }
  const fontColor = resolveColor(font?.color);
  if (fontColor) { style.fontColor = fontColor; hasStyle = true; }

  const fill = cell.fill;
  if (fill?.type === 'pattern' && fill.fgColor) {
    const bg = resolveColor(fill.fgColor);
    if (bg) { style.bgColor = bg; hasStyle = true; }
  }

  const border = cell.border;
  if (border) {
    const bt = resolveBorder(border.top);
    const bb = resolveBorder(border.bottom);
    const bl = resolveBorder(border.left);
    const br = resolveBorder(border.right);
    if (bt) { style.borderTop = bt; hasStyle = true; }
    if (bb) { style.borderBottom = bb; hasStyle = true; }
    if (bl) { style.borderLeft = bl; hasStyle = true; }
    if (br) { style.borderRight = br; hasStyle = true; }
  }

  const alignment = cell.alignment;
  if (alignment?.horizontal) { style.hAlign = alignment.horizontal; hasStyle = true; }

  return hasStyle ? style : undefined;
}
