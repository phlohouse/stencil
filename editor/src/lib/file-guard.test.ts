import { describe, expect, it } from 'vitest';
import {
  LARGE_WORKBOOK_BYTES,
  describeLargeWorkbook,
  formatBytes,
  isLargeWorkbook,
} from './file-guard';

describe('isLargeWorkbook', () => {
  it('flags workbooks at or above the limit', () => {
    expect(isLargeWorkbook(LARGE_WORKBOOK_BYTES - 1)).toBe(false);
    expect(isLargeWorkbook(LARGE_WORKBOOK_BYTES)).toBe(true);
    expect(isLargeWorkbook(120 * 1024 * 1024)).toBe(true);
  });
});

describe('formatBytes', () => {
  it('formats each unit', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(1024 * 1024 * 2.5)).toBe('2.5 MB');
    expect(formatBytes(1024 * 1024 * 1024 * 3)).toBe('3 GB');
  });

  it('handles nonsense sizes', () => {
    expect(formatBytes(-1)).toBe('unknown size');
    expect(formatBytes(Number.NaN)).toBe('unknown size');
  });
});

describe('describeLargeWorkbook', () => {
  it('names the size and the limit', () => {
    const message = describeLargeWorkbook(40 * 1024 * 1024);
    expect(message).toContain('40 MB');
    expect(message).toContain('20 MB');
    expect(message).toContain('Open it anyway?');
  });
});
