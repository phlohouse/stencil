/**
 * Guard rails for opening very large workbooks.
 *
 * The editor keeps the parsed workbook and every sheet's cells in memory, so a
 * workbook of tens of megabytes can freeze the tab. Past this size the editor
 * asks before loading instead of stalling without explanation.
 */
export const LARGE_WORKBOOK_BYTES = 20 * 1024 * 1024;

export function isLargeWorkbook(bytes: number): boolean {
  return bytes >= LARGE_WORKBOOK_BYTES;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unitIndex]}`;
}

export function describeLargeWorkbook(bytes: number): string {
  return (
    `This workbook is ${formatBytes(bytes)}. ` +
    `Workbooks over ${formatBytes(LARGE_WORKBOOK_BYTES)} can be slow to open and scroll, ` +
    'and the editor may become unresponsive. Open it anyway?'
  );
}
