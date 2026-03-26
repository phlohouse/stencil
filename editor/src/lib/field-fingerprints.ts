import type { StencilField } from './types';
import type { CellValue, Workbook } from './excel';
import { getSheetData, getSheetNames } from './excel';
import { colIndexToLetter, parseAddress, letterToColIndex } from './addressing';

const STORAGE_KEY = 'stencil-field-fingerprints';
const RANGE_SUGGESTION_MIN_CONFIDENCE = 0.75;
const SINGLE_CELL_SUGGESTION_MIN_CONFIDENCE = 0.85;
const CURRENT_MATCH_SKIP_THRESHOLD = 0.9;

/**
 * A fingerprint captures the example values at a field's cell/range
 * so we can later find where those values moved to in a new spreadsheet version.
 */
export interface FieldFingerprint {
  fieldName: string;
  /** The cell/range ref as stored in the schema */
  ref: string;
  /** Sample values read from the workbook at capture time */
  sampleValues: string[];
  /** The field type at capture time */
  type?: string;
}

export interface FingerprintStore {
  /** Keyed by "schemaName::discriminatorValue" */
  [key: string]: FieldFingerprint[];
}

export interface RemapSuggestion {
  fieldName: string;
  oldRef: string;
  newRef: string;
  matchedValues: string[];
  confidence: number;
}

interface ParsedRefPosition {
  sheetName: string;
  row: number;
  col: number;
}

interface SingleCellCandidate {
  ref: string;
  exactText: boolean;
  sameSheet: boolean;
  row: number;
  col: number;
}

interface SingleCellMatch {
  ref: string;
  confidence: number;
}

interface RangeMatch {
  ref: string;
  matchedValues: string[];
  confidence: number;
  mode: 'strict' | 'ordered-subsequence';
}

function storageKey(): string {
  return STORAGE_KEY;
}

function loadStore(): FingerprintStore {
  try {
    const raw = localStorage.getItem(storageKey());
    if (raw) return JSON.parse(raw) as FingerprintStore;
  } catch { /* ignore */ }
  return {};
}

function saveStore(store: FingerprintStore): void {
  localStorage.setItem(storageKey(), JSON.stringify(store));
}

function versionKey(schemaName: string, discriminatorValue: string): string {
  return `${schemaName}::${discriminatorValue}`;
}

function cellValueToString(v: CellValue): string {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function parseCellRefPosition(ref: string, defaultSheet: string): ParsedRefPosition | null {
  const sheetSep = ref.indexOf('!');
  const sheetName = sheetSep >= 0 ? ref.slice(0, sheetSep) : defaultSheet;
  const bare = sheetSep >= 0 ? ref.slice(sheetSep + 1) : ref;

  try {
    const addr = parseAddress(bare.split(':', 1)[0]!.toUpperCase());
    return { sheetName, row: addr.row, col: addr.col };
  } catch {
    return null;
  }
}

function isWeakSingleCellValue(value: string): boolean {
  const normalized = normalize(value);
  if (!normalized) return true;
  if (normalized.length <= 2) return true;
  if (/^\d+([./:-]\d+)*$/.test(normalized)) return true;
  if (/^(n\/a|na|yes|no|true|false|pass|fail|ok)$/i.test(normalized)) return true;
  return false;
}

/**
 * Read sample values from a workbook for a single field.
 */
function readFieldValues(
  workbook: Workbook,
  field: StencilField,
  defaultSheet: string,
): string[] {
  const rawRef = field.cell ?? field.range;
  if (!rawRef) return [];

  const sheetSep = rawRef.indexOf('!');
  const sheetName = sheetSep >= 0 ? rawRef.slice(0, sheetSep) : defaultSheet;
  const bare = sheetSep >= 0 ? rawRef.slice(sheetSep + 1) : rawRef;

  let sheetData;
  try {
    sheetData = getSheetData(workbook, sheetName);
  } catch {
    return [];
  }

  if (field.cell) {
    try {
      const addr = parseAddress(bare.toUpperCase());
      const val = sheetData.data[addr.row]?.[addr.col];
      return [cellValueToString(val)];
    } catch {
      return [];
    }
  }

  // Range
  const [startRef, endRef] = bare.split(':');
  if (!startRef) return [];

  try {
    const start = parseAddress(startRef.toUpperCase());

    let endRow: number;
    let endCol: number;
    if (!endRef) {
      endRow = start.row;
      endCol = start.col;
    } else {
      const openEndedMatch = endRef.toUpperCase().match(/^([A-Z]+)$/);
      if (openEndedMatch?.[1]) {
        endCol = letterToColIndex(openEndedMatch[1]);
        // Find last non-empty row
        endRow = start.row;
        for (let r = start.row; r < sheetData.rows; r++) {
          let allEmpty = true;
          for (let c = start.col; c <= endCol; c++) {
            const v = sheetData.data[r]?.[c];
            if (v !== null && v !== undefined && String(v).trim() !== '') {
              allEmpty = false;
              break;
            }
          }
          if (allEmpty) break;
          endRow = r;
        }
      } else {
        const end = parseAddress(endRef.toUpperCase());
        endRow = end.row;
        endCol = end.col;
      }
    }

    const values: string[] = [];
    const maxSamples = 8;
    for (let r = start.row; r <= endRow && values.length < maxSamples; r++) {
      for (let c = start.col; c <= endCol && values.length < maxSamples; c++) {
        values.push(cellValueToString(sheetData.data[r]?.[c]));
      }
    }
    return values;
  } catch {
    return [];
  }
}

/**
 * Capture fingerprints for all fields in a version and persist them.
 */
export function captureFingerprints(
  schemaName: string,
  discriminatorValue: string,
  fields: StencilField[],
  workbook: Workbook,
): void {
  const sheetNames = getSheetNames(workbook);
  const defaultSheet = sheetNames[0] ?? '';

  const fingerprints: FieldFingerprint[] = fields
    .filter((f) => f.cell ?? f.range)
    .map((f) => ({
      fieldName: f.name,
      ref: (f.cell ?? f.range)!,
      sampleValues: readFieldValues(workbook, f, defaultSheet),
      type: f.type,
    }))
    .filter((fp) => fp.sampleValues.some((v) => v.length > 0));

  const store = loadStore();
  store[versionKey(schemaName, discriminatorValue)] = fingerprints;
  saveStore(store);
}

/**
 * Get stored fingerprints for a specific version.
 */
export function getFingerprints(
  schemaName: string,
  discriminatorValue: string,
): FieldFingerprint[] {
  const store = loadStore();
  return store[versionKey(schemaName, discriminatorValue)] ?? [];
}

/**
 * Given fingerprints from an old version, search the current workbook
 * for cells/ranges that contain the same values but at different locations.
 * Returns remap suggestions.
 */
export function findRemappings(
  fingerprints: FieldFingerprint[],
  workbook: Workbook,
  currentFields: StencilField[],
): RemapSuggestion[] {
  const sheetNames = getSheetNames(workbook);
  const defaultSheet = sheetNames[0] ?? '';
  const suggestions: RemapSuggestion[] = [];

  for (const fp of fingerprints) {
    // Check if the current field already points to the right place
    const currentField = currentFields.find((f) => f.name === fp.fieldName);
    const currentRef = currentField?.cell ?? currentField?.range;
    if (!currentRef) {
      console.log(`[remap:${fp.fieldName}] skipped: no current ref`);
      continue;
    }

    // Read current values at the field's existing ref
    const currentValues = currentField
      ? readFieldValues(workbook, currentField, defaultSheet)
      : [];
    const currentMatch = computeMatchScore(fp.sampleValues, currentValues);

    console.log(`[remap:${fp.fieldName}] ref=${currentRef} currentMatch=${currentMatch.toFixed(2)} fingerprint=[${fp.sampleValues.slice(0, 3).join(', ')}] current=[${currentValues.slice(0, 3).join(', ')}]`);

    // If current location already matches well, skip
    if (currentMatch >= CURRENT_MATCH_SKIP_THRESHOLD) {
      console.log(`[remap:${fp.fieldName}] skipped: current location still matches`);
      continue;
    }

    // Only meaningful fingerprints (non-empty values)
    const meaningfulSamples = fp.sampleValues.filter((v) => v.length > 0);
    if (meaningfulSamples.length === 0) continue;

    // Search for the fingerprint values in the workbook
    const isSingleCell = !fp.ref.includes(':') || fp.sampleValues.length === 1;

    // Determine the original sheet so we can prefer same-sheet matches
    const originalPosition = parseCellRefPosition(fp.ref, defaultSheet) ?? parseCellRefPosition(currentRef, defaultSheet);
    const originalSheet = originalPosition?.sheetName ?? defaultSheet;

    if (isSingleCell) {
      const bestMatch = findSingleValueInWorkbook(
        meaningfulSamples[0],
        workbook,
        sheetNames,
        defaultSheet,
        currentRef,
        originalSheet,
        originalPosition,
      );
      console.log(`[remap:${fp.fieldName}] single-cell search: best=${bestMatch?.ref ?? 'none'} conf=${bestMatch?.confidence.toFixed(2) ?? '-'}`);
      if (bestMatch && bestMatch.confidence >= SINGLE_CELL_SUGGESTION_MIN_CONFIDENCE && bestMatch.confidence > currentMatch) {
        suggestions.push({
          fieldName: fp.fieldName,
          oldRef: currentRef,
          newRef: bestMatch.ref,
          matchedValues: [meaningfulSamples[0]],
          confidence: bestMatch.confidence,
        });
      }
    } else {
      const bestMatch = findRangeValuesInWorkbook(
        meaningfulSamples,
        workbook,
        sheetNames,
        defaultSheet,
        currentRef,
        originalSheet,
        originalPosition,
      );
      console.log(`[remap:${fp.fieldName}] range search: best=${bestMatch?.ref ?? 'none'} conf=${bestMatch?.confidence.toFixed(2) ?? '-'} matched=[${bestMatch?.matchedValues.slice(0, 3).join(', ') ?? ''}]`);
      if (bestMatch && bestMatch.confidence >= RANGE_SUGGESTION_MIN_CONFIDENCE && bestMatch.confidence > currentMatch) {
        // Preserve the original range's shape only for strong, structurally ordered matches.
        const adjustedRef = preserveRangeShape(currentRef, bestMatch, currentField);
        suggestions.push({
          fieldName: fp.fieldName,
          oldRef: currentRef,
          newRef: adjustedRef,
          matchedValues: bestMatch.matchedValues,
          confidence: bestMatch.confidence,
        });
      }
    }
  }

  return suggestions
    .filter((s) => s.confidence >= RANGE_SUGGESTION_MIN_CONFIDENCE)
    .sort((a, b) => b.confidence - a.confidence);
}

/**
 * Given an original range ref and a matched ref (which may be just a header row),
 * adjust the matched ref to preserve the original's row span and open-endedness.
 * E.g. original "A15:H" (open-ended) + match "A15:J15" → "A15:J"
 *      original "A13:N109" + match "C13:P13" → "C13:P109"
 */
function preserveRangeShape(
  originalRef: string,
  matched: RangeMatch,
  field: StencilField | undefined,
): string {
  const matchedRef = matched.ref;
  // Extract sheet prefix from matched ref
  const matchSheetSep = matchedRef.indexOf('!');
  const matchSheet = matchSheetSep >= 0 ? matchedRef.slice(0, matchSheetSep + 1) : '';
  const matchBare = matchSheetSep >= 0 ? matchedRef.slice(matchSheetSep + 1) : matchedRef;

  // Parse original ref to get row structure
  const origSheetSep = originalRef.indexOf('!');
  const origBare = origSheetSep >= 0 ? originalRef.slice(origSheetSep + 1) : originalRef;
  const [, origEndPart] = origBare.split(':');

  // Parse matched ref columns
  const [matchStartPart, matchEndPart] = matchBare.split(':');
  if (!matchStartPart) return matchedRef;

  const matchStartCol = matchStartPart.replace(/\d+/g, '');
  const matchStartRow = matchStartPart.replace(/[A-Za-z]+/g, '');
  const matchEndCol = matchEndPart?.replace(/\d+/g, '') ?? matchStartCol;

  // Check if original was open-ended (end part is just column letters, no row number)
  const isOpenEnded = field?.openEnded || (origEndPart && /^[A-Za-z]+$/.test(origEndPart));

  if (isOpenEnded) {
    if (matched.mode !== 'strict') {
      return matchedRef;
    }
    // Open-ended: use matched columns with no end row
    return `${matchSheet}${matchStartCol}${matchStartRow}:${matchEndCol}`;
  }

  // Fixed range: preserve original end row
  if (matched.mode === 'strict' && origEndPart) {
    const origEndRow = origEndPart.replace(/[A-Za-z]+/g, '');
    if (origEndRow) {
      return `${matchSheet}${matchStartCol}${matchStartRow}:${matchEndCol}${origEndRow}`;
    }
  }

  return matchedRef;
}

function computeMatchScore(expected: string[], actual: string[]): number {
  if (expected.length === 0) return 0;
  const meaningful = expected.filter((v) => v.length > 0);
  if (meaningful.length === 0) return 0;

  let matches = 0;
  for (let i = 0; i < meaningful.length; i++) {
    if (i < actual.length && normalize(meaningful[i]) === normalize(actual[i])) {
      matches++;
    }
  }
  return matches / meaningful.length;
}

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

function formatCellRef(sheetName: string, row: number, col: number, defaultSheet: string): string {
  const cellRef = `${colIndexToLetter(col)}${row + 1}`;
  return sheetName === defaultSheet ? cellRef : `${sheetName}!${cellRef}`;
}

function formatRangeRef(
  sheetName: string,
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  defaultSheet: string,
): string {
  const start = `${colIndexToLetter(startCol)}${startRow + 1}`;
  const end = `${colIndexToLetter(endCol)}${endRow + 1}`;
  const rangeRef = `${start}:${end}`;
  return sheetName === defaultSheet ? rangeRef : `${sheetName}!${rangeRef}`;
}

function findSingleValueInWorkbook(
  value: string,
  workbook: Workbook,
  sheetNames: string[],
  defaultSheet: string,
  currentRef: string,
  originalSheet: string,
  originalPosition: ParsedRefPosition | null,
): SingleCellMatch | null {
  const target = normalize(value);
  if (!target) return null;

  const candidates: SingleCellCandidate[] = [];

  // Search same sheet first, then others
  const orderedSheets = [
    originalSheet,
    ...sheetNames.filter((s) => s !== originalSheet),
  ];

  for (const sheetName of orderedSheets) {
    let sheetData;
    try {
      sheetData = getSheetData(workbook, sheetName);
    } catch { continue; }

    const sameSheet = sheetName === originalSheet;

    for (let r = 0; r < sheetData.rows; r++) {
      for (let c = 0; c < sheetData.cols; c++) {
        const cellVal = cellValueToString(sheetData.data[r]?.[c]);
        if (normalize(cellVal) !== target) continue;

        const ref = formatCellRef(sheetName, r, c, defaultSheet);
        if (ref === currentRef) continue;
        candidates.push({
          ref,
          exactText: cellVal === value,
          sameSheet,
          row: r,
          col: c,
        });
      }
    }
  }

  if (candidates.length === 0) return null;

  const sameSheetCandidates = candidates.filter((candidate) => candidate.sameSheet);
  const duplicatePenalty = sameSheetCandidates.length > 1
    ? 0.4
    : candidates.length > 1
      ? 0.7
      : 1;
  const weakValuePenalty = isWeakSingleCellValue(value) ? 0.55 : 1;

  let bestMatch: SingleCellMatch | null = null;
  for (const candidate of candidates) {
    let confidence = candidate.exactText ? 1 : 0.96;
    if (!candidate.sameSheet) confidence *= 0.3;
    confidence *= duplicatePenalty;
    confidence *= weakValuePenalty;

    if (originalPosition && candidate.sameSheet && originalPosition.sheetName === originalSheet) {
      const distance = Math.abs(candidate.row - originalPosition.row) + Math.abs(candidate.col - originalPosition.col);
      const distancePenalty = Math.max(0.55, 1 - Math.min(distance, 80) / 120);
      confidence *= distancePenalty;
    }

    if (!bestMatch || confidence > bestMatch.confidence) {
      bestMatch = { ref: candidate.ref, confidence };
    }
  }

  return bestMatch;
}

function findRangeValuesInWorkbook(
  values: string[],
  workbook: Workbook,
  sheetNames: string[],
  defaultSheet: string,
  currentRef: string,
  originalSheet: string,
  originalPosition: ParsedRefPosition | null,
): RangeMatch | null {
  if (values.length === 0) return null;

  const targets = values.map(normalize);
  let bestMatch: RangeMatch | null = null;

  // Search same sheet first, then others
  const orderedSheets = [
    originalSheet,
    ...sheetNames.filter((s) => s !== originalSheet),
  ];

  for (const sheetName of orderedSheets) {
    let sheetData;
    try {
      sheetData = getSheetData(workbook, sheetName);
    } catch { continue; }

    const sameSheet = sheetName === originalSheet;

    // 1) Strict consecutive sequence matching
    for (let r = 0; r < sheetData.rows; r++) {
      for (let c = 0; c < sheetData.cols; c++) {
        const cellVal = normalize(cellValueToString(sheetData.data[r]?.[c]));
        if (cellVal !== targets[0]) continue;

        // Try vertical match
        const vMatch = matchSequence(sheetData.data, r, c, targets, 'vertical');
        if (vMatch) {
          const ref = formatRangeRef(sheetName, r, c, r + vMatch.length - 1, c, defaultSheet);
          if (ref !== currentRef) {
            let confidence = vMatch.matched / targets.length;
            if (!sameSheet) confidence *= 0.35;
            if (originalPosition && sameSheet) {
              const distance = Math.abs(r - originalPosition.row) + Math.abs(c - originalPosition.col);
              confidence *= Math.max(0.7, 1 - Math.min(distance, 120) / 200);
            }
            if (!bestMatch || confidence > bestMatch.confidence) {
              bestMatch = { ref, matchedValues: vMatch.matchedValues, confidence, mode: 'strict' };
            }
          }
        }

        // Try horizontal match
        const hMatch = matchSequence(sheetData.data, r, c, targets, 'horizontal');
        if (hMatch) {
          const ref = formatRangeRef(sheetName, r, c, r, c + hMatch.length - 1, defaultSheet);
          if (ref !== currentRef) {
            let confidence = hMatch.matched / targets.length;
            if (!sameSheet) confidence *= 0.35;
            if (originalPosition && sameSheet) {
              const distance = Math.abs(r - originalPosition.row) + Math.abs(c - originalPosition.col);
              confidence *= Math.max(0.7, 1 - Math.min(distance, 120) / 200);
            }
            if (!bestMatch || confidence > bestMatch.confidence) {
              bestMatch = { ref, matchedValues: hMatch.matchedValues, confidence, mode: 'strict' };
            }
          }
        }
      }
    }

    // 2) Ordered subsequence scan: tolerate inserted spacers, but keep order and compactness.
    // Limit this to the same sheet; cross-sheet fuzzy remaps are too noisy.
    if (!sameSheet) continue;

    const targetSet = new Set(targets.filter((t) => t.length > 0));
    if (targetSet.size < 3) continue;

    for (let r = 0; r < sheetData.rows; r++) {
      const rowMatch = matchOrderedSubsequence(sheetData.data, r, targets, 'horizontal');
      if (!rowMatch) continue;
      const ref = formatRangeRef(sheetName, r, rowMatch.startIndex, r, rowMatch.endIndex, defaultSheet);
      if (ref === currentRef) continue;
      let confidence = rowMatch.confidence;
      if (originalPosition) {
        const distance = Math.abs(r - originalPosition.row) + Math.abs(rowMatch.startIndex - originalPosition.col);
        confidence *= Math.max(0.7, 1 - Math.min(distance, 120) / 220);
      }
      if (!bestMatch || confidence > bestMatch.confidence) {
        bestMatch = {
          ref,
          matchedValues: rowMatch.matchedValues,
          confidence,
          mode: 'ordered-subsequence',
        };
      }
    }

    for (let c = 0; c < sheetData.cols; c++) {
      const colMatch = matchOrderedSubsequence(sheetData.data, c, targets, 'vertical');
      if (!colMatch) continue;
      const ref = formatRangeRef(sheetName, colMatch.startIndex, c, colMatch.endIndex, c, defaultSheet);
      if (ref === currentRef) continue;
      let confidence = colMatch.confidence;
      if (originalPosition) {
        const distance = Math.abs(colMatch.startIndex - originalPosition.row) + Math.abs(c - originalPosition.col);
        confidence *= Math.max(0.7, 1 - Math.min(distance, 120) / 220);
      }
      if (!bestMatch || confidence > bestMatch.confidence) {
        bestMatch = {
          ref,
          matchedValues: colMatch.matchedValues,
          confidence,
          mode: 'ordered-subsequence',
        };
      }
    }
  }

  return bestMatch;
}

function matchSequence(
  data: CellValue[][],
  startRow: number,
  startCol: number,
  targets: string[],
  direction: 'vertical' | 'horizontal',
): { matched: number; length: number; matchedValues: string[] } | null {
  let matched = 0;
  const matchedValues: string[] = [];
  const len = targets.length;

  for (let i = 0; i < len; i++) {
    const r = direction === 'vertical' ? startRow + i : startRow;
    const c = direction === 'horizontal' ? startCol + i : startCol;
    const cellVal = cellValueToString(data[r]?.[c]);

    if (normalize(cellVal) === targets[i]) {
      matched++;
      matchedValues.push(cellVal);
    }
  }

  const minMatches = Math.min(len, Math.max(3, Math.ceil(len * 0.75)));
  if (matched < minMatches) return null;

  return { matched, length: len, matchedValues };
}

function matchOrderedSubsequence(
  data: CellValue[][],
  fixedIndex: number,
  targets: string[],
  direction: 'vertical' | 'horizontal',
): { matchedValues: string[]; confidence: number; startIndex: number; endIndex: number } | null {
  const minMatches = Math.min(targets.length, Math.max(3, Math.ceil(targets.length * 0.75)));
  const matchedValues: string[] = [];
  let targetIdx = 0;
  let startIndex = -1;
  let endIndex = -1;

  const limit = direction === 'horizontal'
    ? (data[fixedIndex]?.length ?? 0)
    : data.length;

  for (let i = 0; i < limit && targetIdx < targets.length; i++) {
    const row = direction === 'horizontal' ? fixedIndex : i;
    const col = direction === 'horizontal' ? i : fixedIndex;
    const cellVal = cellValueToString(data[row]?.[col]);
    if (normalize(cellVal) !== targets[targetIdx]) continue;

    if (startIndex < 0) startIndex = i;
    endIndex = i;
    matchedValues.push(cellVal);
    targetIdx += 1;
  }

  if (matchedValues.length < minMatches || startIndex < 0 || endIndex < 0) {
    return null;
  }

  const span = endIndex - startIndex + 1;
  const compactness = matchedValues.length / Math.max(span, 1);
  if (compactness < 0.5) return null;

  const coverage = matchedValues.length / targets.length;
  const confidence = coverage * (0.8 + compactness * 0.2);
  return { matchedValues, confidence, startIndex, endIndex };
}
