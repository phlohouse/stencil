import { formatRange, formatSheetRef, parseAddress } from './addressing';
import { slugify } from './field-naming';
import { getCellValue, getSheetData, getSheetNames, type CellInfo, type CellValue, type Workbook } from './excel';
import type { StencilField } from './types';

export type SchemaSuggestion =
  | FieldSuggestion
  | TableSuggestion
  | DiscriminatorSuggestion
  | RemapFieldSuggestion;

interface SuggestionBase {
  id: string;
  kind: 'field' | 'table' | 'discriminator' | 'remap';
  sheetName: string;
  score: number;
  reasons: string[];
  bounds?: ParsedRef;
}

export interface RemapFieldSuggestion extends SuggestionBase {
  kind: 'remap';
  fieldName: string;
  oldRef: string;
  newRef: string;
  field: StencilField;
  targetRef: string;
}

export interface FieldSuggestion extends SuggestionBase {
  kind: 'field';
  field: StencilField;
  sourceLabel: string;
  targetRef: string;
  previewValue: string;
}

export interface TableSuggestion extends SuggestionBase {
  kind: 'table';
  field: StencilField;
  headers: string[];
  targetRef: string;
}

export interface DiscriminatorSuggestion extends SuggestionBase {
  kind: 'discriminator';
  cellRef: string;
  discriminatorValue: string;
  sourceLabel: string;
}

const VERSION_LABEL_RE = /\b(version|template|form|revision|rev|protocol|batch|lot|study)\b/i;
/** Labels that almost always key a schema version rather than naming a value. */
const STRONG_VERSION_LABEL_RE = /\b(version|revision|rev|protocol|template)\b/i;
const MAX_FIELD_SUGGESTIONS = 40;
const MAX_TABLE_SUGGESTIONS = 40;
/** The queue is ranked, so a long tail of lower-confidence extractions is welcome. */
const MAX_SUGGESTIONS = 80;

interface ScanContext {
  existingFields?: StencilField[];
  existingDiscriminatorCells?: string[];
}

interface ParsedRef {
  sheetName: string;
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}

interface HeaderBand {
  startCol: number;
  endCol: number;
  width: number;
  depth: number;
}

export function scanWorkbookForSuggestions(workbook: Workbook, context: ScanContext = {}): SchemaSuggestion[] {
  const sheetNames = getSheetNames(workbook);
  const defaultSheet = sheetNames[0] ?? '';
  const suggestions: SchemaSuggestion[] = [];
  const existingRefs = collectExistingRefs(workbook, defaultSheet, context.existingFields);
  const existingNames = new Set((context.existingFields ?? []).map((field) => field.name));
  const existingDiscriminators = new Set(context.existingDiscriminatorCells ?? []);

  for (const sheetName of sheetNames) {
    const sheetData = getSheetData(workbook, sheetName);
    suggestions.push(
      ...findFieldSuggestions(sheetData, defaultSheet, existingRefs, existingNames),
      ...findRangeSuggestions(sheetData, defaultSheet, existingRefs, existingNames),
      ...findLabelValueSuggestions(sheetData, defaultSheet, existingRefs, existingNames),
      ...findTableSuggestions(sheetData, defaultSheet, existingRefs, existingNames),
      ...findTransposedTableSuggestions(sheetData, defaultSheet, existingRefs, existingNames),
      ...findTitledTableSuggestions(sheetData, defaultSheet, existingRefs, existingNames),
      ...findDiscriminatorSuggestions(sheetData, defaultSheet, existingDiscriminators),
    );
  }

  return disambiguateSuggestionNames(
    suppressOverlaps(dedupeSuggestions(suggestions))
      .filter((suggestion, _index, all) => !isNestedFieldInsideStrongTable(suggestion, all))
      .filter((suggestion) => !shouldDropSuggestion(suggestion))
      .filter(uniqueSuggestionName()),
    existingNames,
  )
    .sort(compareSuggestions)
    .slice(0, MAX_SUGGESTIONS);
}

function findFieldSuggestions(
  sheetData: ReturnType<typeof getSheetData>,
  defaultSheet: string,
  existingRefs: ParsedRef[],
  existingNames: Set<string>,
): FieldSuggestion[] {
  const candidates: FieldSuggestion[] = [];

  for (let row = 0; row < sheetData.rows; row++) {
    for (let col = 0; col < sheetData.cols; col++) {
      const label = asString(sheetData.data[row]?.[col]);
      if (!isLikelyLabel(label)) continue;

      const horizontal = scoreFieldCandidate(
        sheetData,
        row,
        col,
        row,
        col + 1,
        'horizontal',
        defaultSheet,
        existingRefs,
        existingNames,
      );
      const vertical = scoreFieldCandidate(
        sheetData,
        row,
        col,
        row + 1,
        col,
        'vertical',
        defaultSheet,
        existingRefs,
        existingNames,
      );

      if (horizontal) candidates.push(horizontal);
      if (vertical) candidates.push(vertical);
    }
  }

  return candidates
    .sort(compareSuggestions)
    .slice(0, MAX_FIELD_SUGGESTIONS);
}

function findRangeSuggestions(
  sheetData: ReturnType<typeof getSheetData>,
  defaultSheet: string,
  existingRefs: ParsedRef[],
  existingNames: Set<string>,
): FieldSuggestion[] {
  const candidates: FieldSuggestion[] = [];
  const depths = buildDepthTables(sheetData);

  for (let row = 0; row < Math.max(0, sheetData.rows - 3); row++) {
    for (let col = 0; col < sheetData.cols; col++) {
      const label = asString(sheetData.data[row]?.[col]);
      if (!isLikelyLabel(label)) continue;

      const name = slugify(cleanLabel(label));
      if (!name || existingNames.has(name)) continue;
      const headerBand = detectHeaderBand(sheetData, row, col);
      // A merged band titles the section below it; its text never names a list.
      const labelMerge = sheetData.cells[row]?.[col]?.merge;
      if (labelMerge && labelMerge.right > labelMerge.left) continue;

      const verticalDepth = depthAt(depths, 'vertical', sheetData, row + 1, col);
      if (verticalDepth >= 3 && !isBlockColumn(sheetData, row + 1, col, verticalDepth)) {
        const startOffset = findLeadingPlaceholderOffset(
          collectLinearValues(sheetData, row + 1, col, 'vertical', verticalDepth),
        );
        const effectiveDepth = verticalDepth - startOffset;
        if (effectiveDepth < 3) continue;
        const values = collectLinearValues(sheetData, row + 1 + startOffset, col, 'vertical', effectiveDepth);
        if (isAxisLabelRun(label, values)) continue;
        const listType = inferListType(values);
        const start = { row: row + 1 + startOffset, col };
        const end = { row: row + startOffset + effectiveDepth, col };
        const targetRef = formatSheetRef(sheetData.name, formatRange(start, end), defaultSheet);
        if (!refOverlapsExisting(targetRef, defaultSheet, existingRefs)) {
          let score = 0.74;
          const reasons = ['label with a stacked sequence of values below it'];
          if (headerBand && headerBand.width >= 5 && headerBand.depth >= 3) {
            score -= 0.28;
            reasons.push('nearby wide table header makes a standalone column suggestion less likely');
          }
          if (effectiveDepth >= 20) {
            score -= 0.16;
            reasons.push('very long repeated export column is less likely to be a high-level field');
          }
          if (sheetData.name.toLowerCase() === 'raw_data' && effectiveDepth >= 12) {
            score -= 0.1;
            reasons.push('raw export parameters are ranked below business-level table suggestions');
          }
          if (startOffset > 0) {
            score += 0.03;
            reasons.push('leading placeholder values were skipped');
          }
          if (listType !== 'list[str]') {
            score += 0.06;
            reasons.push(`sequence looks like ${listType}`);
          }
          if (looksEmphasized(sheetData.cells[row]?.[col]?.style)) {
            score += 0.06;
            reasons.push('header cell is visually emphasized');
          }
          if (verticalDepth >= 5) {
            score += 0.04;
            reasons.push('longer run makes the range look intentional');
          }
          if (score < 0.6) continue;

          candidates.push({
            id: `range:v:${sheetData.name}:${row}:${col}:${name}`,
            kind: 'field',
            sheetName: sheetData.name,
            score: clampScore(score),
            reasons,
            bounds: {
              sheetName: sheetData.name,
              startRow: start.row,
              endRow: end.row,
              startCol: start.col,
              endCol: end.col,
            },
            sourceLabel: label,
            targetRef,
            previewValue: values.slice(0, 3).map(stringifyValue).join(', '),
            field: {
              name,
              range: targetRef,
              type: listType,
            },
          });
        }
      }

      const horizontalDepth = depthAt(depths, 'horizontal', sheetData, row, col + 1);
      if (
        horizontalDepth >= 3
        && !isMergedAcrossColumns(sheetData, row, col + 1, col + horizontalDepth)
        && !isBlockRow(sheetData, row, col + 1, col + horizontalDepth)
      ) {
        const startOffset = findLeadingPlaceholderOffset(
          collectLinearValues(sheetData, row, col + 1, 'horizontal', horizontalDepth),
        );
        const effectiveDepth = horizontalDepth - startOffset;
        if (effectiveDepth < 3) continue;
        const values = collectLinearValues(sheetData, row, col + 1 + startOffset, 'horizontal', effectiveDepth);
        if (isAxisLabelRun(label, values)) continue;
        const listType = inferListType(values);
        const start = { row, col: col + 1 + startOffset };
        const end = { row, col: col + startOffset + effectiveDepth };
        const targetRef = formatSheetRef(sheetData.name, formatRange(start, end), defaultSheet);
        if (!refOverlapsExisting(targetRef, defaultSheet, existingRefs)) {
          let score = 0.7;
          const reasons = ['label with a repeated sequence of values across the row'];
          if (headerBand && headerBand.width >= 5 && headerBand.depth >= 3) {
            score -= 0.24;
            reasons.push('nearby wide table header makes a standalone row suggestion less likely');
          }
          if (startOffset > 0) {
            score += 0.03;
            reasons.push('leading placeholder values were skipped');
          }
          if (listType !== 'list[str]') {
            score += 0.06;
            reasons.push(`sequence looks like ${listType}`);
          }
          if (score < 0.6) continue;

          candidates.push({
            id: `range:h:${sheetData.name}:${row}:${col}:${name}`,
            kind: 'field',
            sheetName: sheetData.name,
            score: clampScore(score),
            reasons,
            bounds: {
              sheetName: sheetData.name,
              startRow: start.row,
              endRow: end.row,
              startCol: start.col,
              endCol: end.col,
            },
            sourceLabel: label,
            targetRef,
            previewValue: values.slice(0, 3).map(stringifyValue).join(', '),
            field: {
              name,
              range: targetRef,
              type: listType,
            },
          });
        }
      }
    }
  }

  return candidates
    .sort(compareSuggestions)
    .slice(0, MAX_FIELD_SUGGESTIONS);
}

/**
 * Suggest one field per label/value pair. Cover sheets and report headers list
 * their metadata as a column of labels beside a column of values, or as a row of
 * labels with the values in the row underneath. Those pairs are fields rather than
 * tables, and their values are often names that the generic scan ranks low.
 */
function findLabelValueSuggestions(
  sheetData: ReturnType<typeof getSheetData>,
  defaultSheet: string,
  existingRefs: ParsedRef[],
  existingNames: Set<string>,
): FieldSuggestion[] {
  // Cover blocks are read first: a row of labels with the values underneath also
  // looks like a row of label/value pairs, and the cover block reading wins.
  const cover = findCoverBlockSuggestions(sheetData, defaultSheet, existingRefs, existingNames);
  const keyValue = findKeyValueBlockSuggestions(sheetData, defaultSheet, existingRefs, existingNames, cover.covered);

  return [...keyValue, ...cover.suggestions];
}

function findKeyValueBlockSuggestions(
  sheetData: ReturnType<typeof getSheetData>,
  defaultSheet: string,
  existingRefs: ParsedRef[],
  existingNames: Set<string>,
  covered: Set<string>,
): FieldSuggestion[] {
  const candidates: FieldSuggestion[] = [];

  for (const direction of [1, -1] as const) {
    for (let row = 0; row < sheetData.rows; row++) {
      for (let col = 0; col < sheetData.cols; col++) {
        const labelMerge = sheetData.cells[row]?.[col]?.merge;
        // A merged region reports its value in every cell it covers; only its anchor
        // cell can be the label of a pair.
        if (labelMerge && (labelMerge.left !== col || labelMerge.top !== row)) continue;
        // A cell that is the value of the pair on its left is not a label itself.
        if (col > 0 && isFormLabel(sheetData.data[row]?.[col - 1]) && hasOwnValue(sheetData, row, col - 1)) {
          const beforeLeft = col - 2;
          if (beforeLeft < 0 || !isFormLabel(sheetData.data[row]?.[beforeLeft])) continue;
        }
        const valueCol = direction === 1
          ? (labelMerge && labelMerge.right > col ? labelMerge.right + 1 : col + 1)
          : (labelMerge && labelMerge.left < col ? labelMerge.left - 1 : col - 1);
        if (valueCol < 0 || valueCol >= sheetData.cols) continue;
        if (covered.has(cellKey(row, col)) || covered.has(cellKey(row, valueCol))) continue;
        if (!isFormLabel(sheetData.data[row]?.[col])) continue;
        if (!hasOwnValue(sheetData, row, valueCol)) continue;
        // A further value means this is a table row, not a key/value pair. A further
        // *label* with a value of its own means the row alternates pairs, and then
        // every pair in it is a field.
        const beyondCol = valueCol + direction;
        const pairsSideBySide = beyondCol >= 0
          && beyondCol < sheetData.cols
          && isFormLabel(sheetData.data[row]?.[beyondCol])
          && hasOwnValue(sheetData, row, beyondCol + direction);
        if (beyondCol >= 0 && beyondCol < sheetData.cols && hasOwnValue(sheetData, row, beyondCol) && !pairsSideBySide) {
          continue;
        }
        if (
          row > 0
          && isFormLabel(sheetData.data[row - 1]?.[col])
          && hasOwnValue(sheetData, row - 1, valueCol)
        ) {
          continue;
        }

        let end = row;
        while (
          end + 1 < sheetData.rows
          && isFormLabel(sheetData.data[end + 1]?.[col])
          && hasOwnValue(sheetData, end + 1, valueCol)
        ) {
          end += 1;
        }
        const size = end - row + 1;
        // A lone pair inside a plain block is left to the single-pair scan; a pair in
        // a form row (another pair beside it, a label merged across columns, or a
        // sentence-length label) is worth extracting on its own.
        const labelSpansColumns = Boolean(labelMerge && labelMerge.right > labelMerge.left);
        const formLike = pairsSideBySide
          || (labelSpansColumns && !isFormLabel(sheetData.data[row]?.[valueCol]))
          || !isKeyValueLabel(sheetData.data[row]?.[col]);
        if (size < 2 && !formLike) continue;

        for (let current = row; current <= end; current += 1) {
          const label = asString(sheetData.data[current]?.[col]);
          if (!label) continue;
          const value = { row: current, col: valueCol };
          const suggestion = buildLabelValueSuggestion(
            sheetData,
            defaultSheet,
            existingRefs,
            existingNames,
            label,
            value,
            0.7 + (size >= 3 ? 0.04 : 0) + (inferFieldType(sheetData.data[value.row]?.[value.col]) !== 'str' ? 0.04 : 0),
            ['label and value are listed as a key/value row'],
          );
          if (suggestion) candidates.push(suggestion);
        }
      }
    }
  }

  return candidates;
}

interface CoverBlock {
  labelCols: number[];
  valueCols: number[];
}

/**
 * A cover block is a row of labels with its values on the row underneath and
 * nothing else below: a report header or cover sheet, not a table.
 */
function detectCoverBlock(
  sheetData: ReturnType<typeof getSheetData>,
  row: number,
): CoverBlock | null {
  if (row + 1 >= sheetData.rows) return null;

  const labelCols: number[] = [];
  for (let col = 0; col < sheetData.cols; col++) {
    const value = sheetData.data[row]?.[col];
    if (!hasValue(value)) continue;
    // A merged region repeats its value in every cell it covers; it is one label, and
    // a band merged across the whole row leaves a single one.
    if (!hasOwnValue(sheetData, row, col)) continue;
    if (!isKeyValueLabel(value)) return null;
    labelCols.push(col);
  }
  if (labelCols.length < 2) return null;

  const valueCols = labelCols.filter((col) => hasValue(sheetData.data[row + 1]?.[col]));
  if (valueCols.length < 1) return null;
  if (row > 0 && valueCols.some((col) => hasValue(sheetData.data[row - 1]?.[col]))) return null;

  // The row below has to hold values; a row of labels underneath means this is a
  // table header rather than a cover block.
  const hasValues = valueCols.some((col) => !isKeyValueLabel(sheetData.data[row + 1]?.[col]));
  if (!hasValues) return null;

  // A deeper block is a table; a cover block is exactly two rows.
  if (row + 2 < sheetData.rows && valueCols.some((col) => hasValue(sheetData.data[row + 2]?.[col]))) return null;

  return { labelCols, valueCols };
}

function findCoverBlockSuggestions(
  sheetData: ReturnType<typeof getSheetData>,
  defaultSheet: string,
  existingRefs: ParsedRef[],
  existingNames: Set<string>,
): { suggestions: FieldSuggestion[]; covered: Set<string> } {
  const candidates: FieldSuggestion[] = [];
  const covered = new Set<string>();

  for (let row = 0; row + 1 < sheetData.rows; row++) {
    const block = detectCoverBlock(sheetData, row);
    if (!block) continue;
    const { valueCols } = block;

    for (const col of valueCols) {
      covered.add(cellKey(row, col));
      covered.add(cellKey(row + 1, col));

      const label = asString(sheetData.data[row]?.[col]);
      if (!label) continue;
      const value = { row: row + 1, col };
      const suggestion = buildLabelValueSuggestion(
        sheetData,
        defaultSheet,
        existingRefs,
        existingNames,
        label,
        value,
        0.72,
        ['label with its value on the row underneath'],
      );
      if (suggestion) candidates.push(suggestion);
    }
  }

  return { suggestions: candidates, covered };
}

function cellKey(row: number, col: number): string {
  return `${row}:${col}`;
}

function buildLabelValueSuggestion(
  sheetData: ReturnType<typeof getSheetData>,
  defaultSheet: string,
  existingRefs: ParsedRef[],
  existingNames: Set<string>,
  label: string,
  value: { row: number; col: number },
  score: number,
  reasons: string[],
): FieldSuggestion | null {
  const name = slugify(cleanLabel(label));
  if (!name || name.length < 2) return null;
  if (existingNames.has(name)) return null;

  const targetRef = formatSheetRef(sheetData.name, formatRange(value, value), defaultSheet);
  if (refOverlapsExisting(targetRef, defaultSheet, existingRefs)) return null;

  const cellValue = sheetData.data[value.row]?.[value.col];
  const inferredType = inferFieldType(cellValue);

  return {
    id: `label-value:${sheetData.name}:${value.row}:${value.col}:${name}`,
    kind: 'field',
    sheetName: sheetData.name,
    score: clampScore(score),
    reasons,
    bounds: {
      sheetName: sheetData.name,
      startRow: value.row,
      endRow: value.row,
      startCol: value.col,
      endCol: value.col,
    },
    sourceLabel: label,
    targetRef,
    previewValue: stringifyValue(cellValue),
    field: {
      name,
      cell: targetRef,
      type: inferredType === 'str' ? undefined : inferredType,
    },
  };
}

/** A label that names the value beside or below it, not data that looks like a label. */
function isKeyValueLabel(value: CellValue | undefined): boolean {
  const text = asString(value);
  if (!text) return false;
  if (looksDataLikeLabel(text) || looksStatusLike(text)) return false;
  return isLikelyLabel(text);
}

/**
 * A single letter heading a run of single letters is a grid axis (A..H down a plate
 * map), not a field. Anything longer is a real label, so flags such as Y/N survive.
 */
function isAxisLabelRun(label: string, values: CellValue[]): boolean {
  if (label.trim().length !== 1) return false;
  const texts = values.map((value) => stringifyValue(value)).filter(Boolean);
  return texts.length >= 3 && texts.every((text) => text.length === 1);
}

/**
 * A form label names the value beside it, so it may be a full sentence ("PBS
 * aliquoted for Blank and NPC as per PRDSOP"). The word limits that keep prose out of
 * table headers do not apply when a label and its value sit next to each other.
 */
function isFormLabel(value: CellValue | undefined): boolean {
  if (isKeyValueLabel(value)) return true;
  const text = asString(value);
  if (!text) return false;
  if (looksDataLikeLabel(text) || looksStatusLike(text)) return false;
  if (text.length > 90 || text.split(/\s+/).length > 14) return false;
  if (/[<>=%]/.test(text)) return false;
  return /[a-z]/i.test(text);
}

function scoreFieldCandidate(
  sheetData: ReturnType<typeof getSheetData>,
  labelRow: number,
  labelCol: number,
  valueRow: number,
  valueCol: number,
  axis: 'horizontal' | 'vertical',
  defaultSheet: string,
  existingRefs: ParsedRef[],
  existingNames: Set<string>,
): FieldSuggestion | null {
  if (valueRow >= sheetData.rows || valueCol >= sheetData.cols) return null;

  const label = asString(sheetData.data[labelRow]?.[labelCol]) ?? '';
  const rawName = cleanLabel(label);
  const name = slugify(rawName);
  if (!name || name.length < 2) return null;
  // A merged region repeats its value across the cells it covers; only its anchor can
  // be the label of a pair.
  if (!hasOwnValue(sheetData, labelRow, labelCol)) return null;
  if (existingNames.has(name)) return null;
  const headerBand = detectHeaderBand(sheetData, labelRow, labelCol);

  const value = sheetData.data[valueRow]?.[valueCol];
  if (!hasValue(value)) return null;

  const valueString = stringifyValue(value);
  if (!valueString) return null;

  let score = 0.46;
  const reasons = [`label/value pair found ${axis === 'horizontal' ? 'across a row' : 'down a column'}`];
  const labelStyle = sheetData.cells[labelRow]?.[labelCol]?.style;

  if (axis === 'horizontal') {
    score += 0.08;
  }
  if (label !== rawName) {
    score += 0.04;
    reasons.push('label text cleaned cleanly into a field name');
  }
  if (looksEmphasized(labelStyle)) {
    score += 0.1;
    reasons.push('label cell is visually emphasized');
  }

  const inferredType = inferFieldType(value);
  if (inferredType !== 'str') {
    score += 0.08;
    reasons.push(`value looks like ${inferredType}`);
  }

  if (valueString.length <= 40) {
    score += 0.05;
    reasons.push('value is compact enough to look like a scalar field');
  }

  if (looksIdentifierLike(valueString)) {
    score += 0.12;
    reasons.push('value looks like a stable identifier');
  } else if (isLikelyLabel(valueString)) {
    score -= 0.18;
    reasons.push('value also looks like a label');
  }

  if (rawName.split(/\s+/).length > 5) {
    score -= 0.08;
    reasons.push('label is fairly long and may be descriptive copy');
  }
  if (headerBand && headerBand.width >= 3 && headerBand.depth >= 1) {
    score -= axis === 'horizontal' ? 0.24 : 0.16;
    reasons.push('label appears inside a wider table header band');
  }

  if (score < 0.58) return null;

  const targetRef = formatSheetRef(
    sheetData.name,
    formatRange({ row: valueRow, col: valueCol }, { row: valueRow, col: valueCol }),
    defaultSheet,
  );
  if (refOverlapsExisting(targetRef, defaultSheet, existingRefs)) return null;

  return {
    id: `field:${sheetData.name}:${valueRow}:${valueCol}:${name}`,
    kind: 'field',
    sheetName: sheetData.name,
    score: clampScore(score),
    reasons,
    bounds: {
      sheetName: sheetData.name,
      startRow: valueRow,
      endRow: valueRow,
      startCol: valueCol,
      endCol: valueCol,
    },
    sourceLabel: label,
    targetRef,
    previewValue: valueString,
    field: {
      name,
      cell: targetRef,
      type: inferredType === 'str' ? undefined : inferredType,
    },
  };
}

function findTableSuggestions(
  sheetData: ReturnType<typeof getSheetData>,
  defaultSheet: string,
  existingRefs: ParsedRef[],
  existingNames: Set<string>,
): TableSuggestion[] {
  const candidates: TableSuggestion[] = [];

  for (let row = 0; row < Math.max(0, sheetData.rows - 2); row++) {
    const runs = coalesceHeaderRuns(sheetData, row, findNonEmptyRuns(sheetData.data[row] ?? [], sheetData.hiddenCols));
    for (const run of runs) {
      if (run.length < 2) continue;

      const rawHeaders = run.values.map((value) => cleanLabel(value));
      const headers = rawHeaders.filter(Boolean);
      const blankHeaderCount = rawHeaders.length - headers.length;
      if (headers.length < Math.max(2, Math.ceil(run.length * 0.6))) continue;
      if (blankHeaderCount > 2) continue;
      if (!hasInformativeHeaders(headers)) continue;
      if (detectCoverBlock(sheetData, row)) continue;

      const assessment = assessHeaderRow(sheetData, row, run.start, run.end);
      if (!assessment.ok) continue;
      if (headers.some((header) => !slugify(header))) continue;
      // Single letter headers (K, Na) are fine; junk without letters is not, and
      // typed headers such as years carry no letters at all.
      if (assessment.kind === 'labels' && headers.some((header) => !/[a-z]/i.test(header))) continue;

      const headerLikeCount = headers.filter(isLikelyHeaderCell).length;
      const dataLikeHeaderCount = headers.filter((header) => looksDataLikeLabel(header) || looksStatusLike(header)).length;
      if (isSectionBand(sheetData, row, run.start, run.end)) continue;
      if (assessment.kind === 'labels') {
        const informativeHeaderCount = headerLikeCount + dataLikeHeaderCount;
        if (headers.length >= 4 && headerLikeCount < Math.max(2, Math.ceil(headers.length * 0.3))) continue;
        if (headers.length >= 4 && informativeHeaderCount < Math.ceil(headers.length * 0.75)) continue;
        if (dataLikeHeaderCount > Math.floor(headers.length * 0.65)) continue;
      }

      const block = measureTableBlock(sheetData, row + 1, run.start, run.end, 1);
      const strictBlock = measureTableBlock(sheetData, row + 1, run.start, run.end, 0);
      const depth = strictBlock.depth;
      const scoringDepth = block.depth;
      const boundsEndRow = strictBlock.endRow;

      const judgedColumns = (assessment.columns ?? []).filter((column) => column.judged);
      const allLabelColumns = judgedColumns.length >= 2
        && judgedColumns.every((column) => column.dominantClass === 'label');
      if (run.length <= 2 && depth <= 2 && allLabelColumns) continue;
      const firstColumnBlock = measureFirstColumnBlock(sheetData, row + 1, run.start);
      const effectiveDepth = Math.max(depth, firstColumnBlock.depth);
      const boundsEnd = Math.max(boundsEndRow, firstColumnBlock.endRow);
      const sampleRowValues = collectRowValues(sheetData, row + 1, run.start, run.end);
      const identifierLikeCells = sampleRowValues.filter((value) => looksIdentifierLike(stringifyValue(value))).length;
      const width = run.end - run.start + 1;
      const typedSampleCells = sampleRowValues.filter((value) => (
        looksIdentifierLike(stringifyValue(value))
        || inferFieldType(value) !== 'str'
        || looksStatusLike(stringifyValue(value))
        || stringifyValue(value).startsWith('=')
      )).length;
      const shallowStructuredRow = effectiveDepth === 1
        && sampleRowValues.filter(hasValue).length >= Math.max(2, Math.ceil(run.length * 0.5))
        && typedSampleCells >= Math.max(2, Math.ceil(width * 0.35));
      if (effectiveDepth < 2 && (assessment.kind === 'typed' || !shallowStructuredRow)) continue;

      let score = 0.62;
      const reasons = ['contiguous header row with repeated data underneath'];
      if (assessment.kind === 'typed') {
        reasons.push('top row repeats the same typed values that label the columns');
      }

      if (scoringDepth >= 3) {
        score += 0.08;
        reasons.push('multiple populated data rows reinforce the table shape');
      } else if (shallowStructuredRow) {
        score -= 0.04;
        reasons.push('single populated data row, but the row still looks structured');
      }
      if (headers.every((header) => isLikelyLabel(header))) {
        score += 0.05;
        reasons.push('header cells read like column labels');
      }
      if (headerLikeCount >= Math.ceil(run.length * 0.75)) {
        score += 0.08;
        reasons.push('header row is strongly label-like');
      }
      if (looksEmphasizedAcrossRow(sheetData, row, run.start, run.end)) {
        score += 0.06;
        reasons.push('header row is visually emphasized');
      }
      if (identifierLikeCells > 0) {
        score += 0.06;
        reasons.push('sample values look like record identifiers');
      }
      if (width >= 5) {
        score += 0.1;
        reasons.push('wide header row suggests a full table rather than isolated columns');
      }
      if (scoringDepth >= 4) {
        score += 0.06;
        reasons.push('repeated populated rows reinforce the grid structure');
      }
      if (typedSampleCells >= Math.max(3, Math.ceil(width * 0.45))) {
        score += 0.05;
        reasons.push('sample row mixes IDs, statuses, or typed values across many columns');
      }
      if (blankHeaderCount > 0) {
        score -= 0.03 * blankHeaderCount;
        reasons.push('header band includes spacer columns');
      }
      const sectionTitle = findNearbySectionTitle(sheetData, row, run.start, run.end);
      if (sectionTitle) {
        score += /^table\s+\d+/i.test(sectionTitle) ? 0.14 : 0.08;
        reasons.push('nearby section title reinforces the table grouping');
      }
      if (width >= 10) {
        score += 0.06;
        reasons.push('broad multi-column layout looks more like a primary table');
      }
      if (sampleRowValues.some((value) => stringifyValue(value).startsWith('='))) {
        score -= 0.08;
        reasons.push('formula-heavy sample rows are less likely to be business tables');
      }

      const name = suggestTableName(sheetData, row, run.start, run.end, headers);
      if (!name) continue;
      if (existingNames.has(name)) continue;

      const start = { row, col: run.start };
      const end = { row, col: run.end };
      const targetRef = formatSheetRef(sheetData.name, formatRange(start, end, true), defaultSheet);
      if (refOverlapsExisting(targetRef, defaultSheet, existingRefs)) continue;

      candidates.push({
        id: `table:${sheetData.name}:${row}:${run.start}:${run.end}`,
        kind: 'table',
        sheetName: sheetData.name,
        score: clampScore(score),
        reasons,
        bounds: {
          sheetName: sheetData.name,
          startRow: row,
          endRow: Math.max(row, boundsEnd),
          startCol: run.start,
          endCol: run.end,
        },
        headers,
        targetRef,
        field: {
          name,
          range: targetRef,
          type: 'table',
          openEnded: true,
          columns: buildTableColumns(rawHeaders, run.start),
        },
      });
    }
  }

  return candidates
    .sort(compareSuggestions)
    .slice(0, MAX_TABLE_SUGGESTIONS);
}

function findDiscriminatorSuggestions(
  sheetData: ReturnType<typeof getSheetData>,
  defaultSheet: string,
  existingDiscriminators: Set<string>,
): DiscriminatorSuggestion[] {
  const candidates: DiscriminatorSuggestion[] = [];
  const maxRows = Math.min(sheetData.rows, 20);
  const maxCols = Math.min(sheetData.cols, 8);

  for (let row = 0; row < maxRows; row++) {
    for (let col = 0; col < maxCols; col++) {
      const label = asString(sheetData.data[row]?.[col]);
      if (!label || !isLikelyLabel(label) || !VERSION_LABEL_RE.test(label)) continue;

      const value = sheetData.data[row]?.[col + 1] ?? sheetData.data[row + 1]?.[col];
      const valueRef = sheetData.data[row]?.[col + 1] != null
        ? { row, col: col + 1 }
        : { row: row + 1, col };
      if (!hasValue(value) || valueRef.row >= sheetData.rows || valueRef.col >= sheetData.cols) continue;

      const valueString = stringifyValue(value);
      // A discriminator value is a short code or name, not a sentence.
      if (!valueString || valueString.length > 40 || valueString.split(/\s+/).length > 4) continue;

      let score = 0.65;
      const reasons = ['keyword label suggests a version or revision field'];
      if (STRONG_VERSION_LABEL_RE.test(label)) {
        score += 0.05;
        reasons.push('label names a schema version directly');
      }
      if (looksVersionLike(valueString)) {
        score += 0.12;
        reasons.push('adjacent value looks version-like');
      }
      if (looksEmphasized(sheetData.cells[row]?.[col]?.style)) {
        score += 0.06;
        reasons.push('label is visually emphasized near the top of the sheet');
      }

      const cellRef = formatSheetRef(
        sheetData.name,
        formatRange(valueRef, valueRef),
        defaultSheet,
      );
      if (existingDiscriminators.has(cellRef)) continue;

      candidates.push({
        id: `disc:${sheetData.name}:${valueRef.row}:${valueRef.col}`,
        kind: 'discriminator',
        sheetName: sheetData.name,
        score: clampScore(score),
        reasons,
        bounds: {
          sheetName: sheetData.name,
          startRow: valueRef.row,
          endRow: valueRef.row,
          startCol: valueRef.col,
          endCol: valueRef.col,
        },
        cellRef,
        discriminatorValue: valueString,
        sourceLabel: label,
      });
    }
  }

  return candidates;
}

/**
 * A transposed table keeps one record per column: the first column names the values
 * and the row above the data names the records. The blank corner cell is what tells
 * it apart from a normal table, and reading it this way keeps the label column that
 * a horizontal reading would leave behind.
 */
function findTransposedTableSuggestions(
  sheetData: ReturnType<typeof getSheetData>,
  defaultSheet: string,
  existingRefs: ParsedRef[],
  existingNames: Set<string>,
): TableSuggestion[] {
  const candidates: TableSuggestion[] = [];

  for (let headerRow = 0; headerRow < Math.max(0, sheetData.rows - 2); headerRow++) {
    for (let labelCol = 0; labelCol + 2 < sheetData.cols; labelCol++) {
      if (hasValue(sheetData.data[headerRow]?.[labelCol])) continue;

      const recordCols: number[] = [];
      let recordLike = true;
      for (let col = labelCol + 1; col < sheetData.cols; col++) {
        const value = sheetData.data[headerRow]?.[col];
        if (!hasValue(value)) break;
        if (!isRecordName(value)) {
          recordLike = false;
          break;
        }
        recordCols.push(col);
      }
      if (!recordLike || recordCols.length < 2) continue;

      const endCol = recordCols[recordCols.length - 1];
      // A transposed block stops at the first blank row: the next block is a
      // different table.
      const block = measureTableBlock(sheetData, headerRow + 1, labelCol, endCol, 0);
      if (block.depth < 2) continue;

      const labels: string[] = [];
      let everyRowLabelled = true;
      for (let row = headerRow + 1; row <= block.endRow; row++) {
        const label = asString(sheetData.data[row]?.[labelCol]);
        if (!label || !isKeyValueLabel(label) || populatedInRange(sheetData, row, labelCol + 1, endCol) < 2) {
          everyRowLabelled = false;
          break;
        }
        labels.push(label);
      }
      if (!everyRowLabelled) continue;

      const name = transposedTableName(sheetData, headerRow, labelCol, endCol);
      if (!name || existingNames.has(name)) continue;

      const targetRef = formatSheetRef(
        sheetData.name,
        formatRange({ row: headerRow, col: labelCol }, { row: headerRow, col: endCol }, true),
        defaultSheet,
      );
      if (refOverlapsExisting(targetRef, defaultSheet, existingRefs)) continue;

      const rowNames = disambiguateHeaders(labels);
      const columns: Record<string, string> = { [String(headerRow + 1)]: 'record_name' };
      labels.forEach((_label, index) => {
        columns[String(headerRow + 2 + index)] = rowNames[index];
      });

      const width = endCol - labelCol + 1;
      let score = 0.86;
      const reasons = [
        'each column holds a record while the first column names its values',
        'the record row and the label column are both populated',
      ];
      if (width >= 4) {
        score += 0.05;
        reasons.push('wide matrix with several records');
      }
      if (block.depth >= 4) {
        score += 0.04;
        reasons.push('several labelled rows reinforce the layout');
      }

      candidates.push({
        id: `table-vertical:${sheetData.name}:${headerRow}:${labelCol}:${endCol}`,
        kind: 'table',
        sheetName: sheetData.name,
        score: clampScore(score),
        reasons,
        bounds: {
          sheetName: sheetData.name,
          startRow: headerRow,
          endRow: block.endRow,
          startCol: labelCol,
          endCol,
        },
        headers: labels,
        targetRef,
        field: {
          name,
          range: targetRef,
          type: 'table',
          openEnded: true,
          tableOrientation: 'vertical',
          columns,
        },
      });
    }
  }

  return candidates
    .sort(compareSuggestions)
    .slice(0, MAX_TABLE_SUGGESTIONS);
}

function transposedTableName(
  sheetData: ReturnType<typeof getSheetData>,
  headerRow: number,
  startCol: number,
  endCol: number,
): string {
  const sectionTitle = findNearbySectionTitle(sheetData, headerRow, startCol, endCol);
  const fromTitle = slugify(sectionTitle ?? '');
  if (fromTitle) return `${fromTitle}_table`;

  const sheet = slugify(sheetData.name);
  return sheet ? `${sheet}_table` : '';
}

/** A short, record-like cell: an identifier, a code, a number, a date or a plain label. */
function isRecordName(value: CellValue | undefined): boolean {
  if (value === null || value === undefined) return false;
  const text = stringifyValue(value);
  if (!text || text.length > 40) return false;
  return isLikelyLabel(text) || looksIdentifierLike(text) || inferFieldType(value) !== 'str';
}

function findTitledTableSuggestions(
  sheetData: ReturnType<typeof getSheetData>,
  defaultSheet: string,
  existingRefs: ParsedRef[],
  existingNames: Set<string>,
): TableSuggestion[] {
  const candidates: TableSuggestion[] = [];

  for (let row = 0; row < sheetData.rows; row++) {
    const titleCells = (sheetData.data[row] ?? [])
      .map((value, col) => ({ value: asString(value), col }))
      .filter((entry): entry is { value: string; col: number } => Boolean(entry.value))
      .filter((entry) => /^table\s+\d+\s*:/i.test(entry.value));

    for (const titleCell of titleCells) {
      const title = normalizeSectionTitle(titleCell.value);
      if (!title) continue;

      const titledRuns: Array<{ row: number; start: number; end: number; values: string[]; depth: number; scoringDepth: number; endRow: number; distance: number }> = [];
      for (let headerRow = row + 1; headerRow <= Math.min(sheetData.rows - 1, row + 3); headerRow++) {
        const baseRuns = findNonEmptyRuns(sheetData.data[headerRow] ?? [], sheetData.hiddenCols);
        const anchoredRuns = baseRuns.filter((run) => run.start >= titleCell.col);
        const mergedRuns = coalesceRunsAcrossSpacers(sheetData, headerRow, anchoredRuns);
        const runs = [...baseRuns, ...mergedRuns].filter((run, index, all) =>
          all.findIndex((candidate) => candidate.start === run.start && candidate.end === run.end) === index,
        );
        for (const run of runs) {
          if (run.length < 4) continue;
          const distance = Math.abs(run.start - titleCell.col);
          if (distance > 4) continue;
          const rawHeaders = run.values.map((value) => cleanLabel(value));
          const headers = rawHeaders.filter(Boolean);
          const blankHeaderCount = rawHeaders.length - headers.length;
          if (headers.length < Math.max(2, Math.ceil(run.length * 0.6))) continue;
          if (blankHeaderCount > (distance === 0 ? 3 : 2)) continue;
          if (headers.some((header) => !slugify(header) || !/[a-z]/i.test(header))) continue;
          if (hasGroupHeaderRow(sheetData, headerRow, run.start, run.end)) continue;
          if (isSectionBand(sheetData, headerRow, run.start, run.end)) continue;
          const headerLikeCount = headers.filter(isLikelyHeaderCell).length;
          const dataLikeHeaderCount = headers.filter((header) => looksDataLikeLabel(header) || looksStatusLike(header)).length;
          const informativeHeaderCount = headerLikeCount + dataLikeHeaderCount;
          if (headers.length >= 4 && headerLikeCount < Math.max(2, Math.ceil(headers.length * 0.3))) continue;
          if (headers.length >= 4 && informativeHeaderCount < Math.ceil(headers.length * 0.75)) continue;
          if (dataLikeHeaderCount > Math.floor(headers.length * 0.65)) continue;
          const block = measureTableBlock(sheetData, headerRow + 1, run.start, run.end, 1);
          const strictBlock = measureTableBlock(sheetData, headerRow + 1, run.start, run.end, 0);
          const depth = strictBlock.depth;
          const scoringDepth = block.depth;
          const boundsEndRow = strictBlock.endRow;
          const sampleRowValues = collectRowValues(sheetData, headerRow + 1, run.start, run.end);
          const typedSampleCells = sampleRowValues.filter((value) => (
            looksIdentifierLike(stringifyValue(value))
            || inferFieldType(value) !== 'str'
            || looksStatusLike(stringifyValue(value))
            || stringifyValue(value).startsWith('=')
          )).length;
          const firstColumnBlock = measureFirstColumnBlock(sheetData, headerRow + 1, run.start);
          const effectiveDepth = Math.max(depth, firstColumnBlock.depth);
          const shallowStructuredRow = effectiveDepth === 1
            && sampleRowValues.filter(hasValue).length >= Math.max(2, Math.ceil(run.length * 0.35))
            && typedSampleCells >= Math.max(2, Math.ceil(run.length * 0.25));
          if (effectiveDepth < 2 && !shallowStructuredRow) continue;
          titledRuns.push({ row: headerRow, start: run.start, end: run.end, values: run.values, depth: effectiveDepth, scoringDepth, endRow: Math.max(boundsEndRow, firstColumnBlock.endRow), distance });
        }
      }

      const sortedRuns = titledRuns
        .sort((a, b) => {
          const distanceDelta = a.distance - b.distance;
          if (distanceDelta !== 0) return distanceDelta;
          const widthDelta = (b.end - b.start) - (a.end - a.start);
          if (widthDelta !== 0) return widthDelta;
          return b.depth - a.depth;
        })
        .slice(0, 3);

      for (const [index, run] of sortedRuns.entries()) {
        const headers = run.values.map((value) => cleanLabel(value));
        const nameBase = slugify(title);
        const fallbackHeader = slugify(headers.find(Boolean) ?? '') || `section_${index + 1}`;
        const name = nameBase
          ? index === 0 ? `${nameBase}_table` : `${nameBase}_${fallbackHeader}_table`
          : '';
        if (!name || existingNames.has(name)) continue;

        const start = { row: run.row, col: run.start };
        const end = { row: run.row, col: run.end };
        const targetRef = formatSheetRef(sheetData.name, formatRange(start, end, true), defaultSheet);
        if (refOverlapsExisting(targetRef, defaultSheet, existingRefs)) continue;

        let score = 0.94;
        const reasons = [
          'nearby explicit table title identifies the region as a named table',
          'contiguous header row with repeated data underneath',
        ];
        if (run.scoringDepth >= 3) {
          score += 0.06;
          reasons.push('multiple populated data rows reinforce the table shape');
        }
        if (run.end - run.start + 1 >= 8) {
          score += 0.06;
          reasons.push('wide titled region looks like a primary report table');
        }
        if (looksEmphasizedAcrossRow(sheetData, run.row, run.start, run.end)) {
          score += 0.04;
          reasons.push('header row is visually emphasized');
        }

        candidates.push({
          id: `titled-table:${sheetData.name}:${row}:${run.row}:${run.start}:${run.end}`,
          kind: 'table',
          sheetName: sheetData.name,
          score: clampScore(score),
          reasons,
          bounds: {
            sheetName: sheetData.name,
            startRow: run.row,
            endRow: Math.max(run.row, run.endRow),
            startCol: run.start,
            endCol: run.end,
          },
          headers,
          targetRef,
          field: {
            name,
            range: targetRef,
            type: 'table',
            openEnded: true,
            columns: buildTableColumns(run.values.map((value) => cleanLabel(value)), run.start),
          },
        });
      }
    }
  }

  return candidates
    .sort(compareSuggestions)
    .slice(0, MAX_TABLE_SUGGESTIONS);
}

function dedupeSuggestions(suggestions: SchemaSuggestion[]): SchemaSuggestion[] {
  const best = new Map<string, SchemaSuggestion>();

  for (const suggestion of suggestions) {
    let key = suggestion.id;
    if (suggestion.kind === 'field') {
      key = `${suggestion.kind}:${suggestion.field.name}:${suggestion.targetRef}`;
    }
    if (suggestion.kind === 'table') {
      key = `${suggestion.kind}:${suggestion.targetRef}`;
    }
    if (suggestion.kind === 'discriminator') {
      key = `${suggestion.kind}:${suggestion.cellRef}`;
    }

    const existing = best.get(key);
    if (!existing || existing.score < suggestion.score) {
      best.set(key, suggestion);
    }
  }

  return [...best.values()];
}

function suppressOverlaps(suggestions: SchemaSuggestion[]): SchemaSuggestion[] {
  const ordered = [...suggestions].sort(compareSuggestions);
  const accepted: SchemaSuggestion[] = [];
  const occupied: ParsedRef[] = [];

  for (const suggestion of ordered) {
    const parsed = parseSuggestionRef(suggestion);
    if (parsed && occupied.some((candidate) => refsOverlap(candidate, parsed))) {
      continue;
    }
    accepted.push(suggestion);
    if (parsed) occupied.push(parsed);
  }

  return accepted;
}

function findNonEmptyRuns(
  row: CellValue[],
  hiddenCols: boolean[] = [],
): Array<{ start: number; end: number; length: number; values: string[] }> {
  const runs: Array<{ start: number; end: number; length: number; values: string[] }> = [];
  let start = -1;

  for (let col = 0; col <= row.length; col++) {
    const value = row[col];
    const isHidden = hiddenCols[col] ?? false;
    if (start === -1 && hasValue(value)) {
      start = col;
      continue;
    }
    if (start !== -1 && isHidden && !hasValue(value)) {
      continue;
    }
    if (start !== -1 && !hasValue(value)) {
      const values = row.slice(start, col).map((cell) => stringifyValue(cell)).filter(Boolean);
      runs.push({ start, end: col - 1, length: col - start, values });
      start = -1;
    }
  }

  return runs;
}

function coalesceHeaderRuns(
  sheetData: ReturnType<typeof getSheetData>,
  row: number,
  runs: Array<{ start: number; end: number; length: number; values: string[] }>,
): Array<{ start: number; end: number; length: number; values: string[] }> {
  if (runs.length <= 1) return runs;

  const merged: Array<{ start: number; end: number; length: number; values: string[] }> = [];
  let current = { ...runs[0] };

  for (let index = 1; index < runs.length; index++) {
    const next = runs[index];
    const gap = next.start - current.end - 1;

    if (gap <= 1 && shouldMergeHeaderRuns(sheetData, row, current, next)) {
      const combinedValues = (sheetData.data[row] ?? [])
        .slice(current.start, next.end + 1)
        .map((cell) => stringifyValue(cell));
      current = {
        start: current.start,
        end: next.end,
        length: next.end - current.start + 1,
        values: combinedValues,
      };
      continue;
    }

    merged.push(current);
    current = { ...next };
  }

  merged.push(current);
  return merged;
}

function shouldMergeHeaderRuns(
  sheetData: ReturnType<typeof getSheetData>,
  row: number,
  left: { start: number; end: number },
  right: { start: number; end: number },
): boolean {
  if (runsAreSeparateBlocks(sheetData, row, left, right)) return false;

  const combinedDepth = measureTableDepth(sheetData, row + 1, left.start, right.end);
  if (combinedDepth >= 2) return true;

  const sampleRow = collectRowValues(sheetData, row + 1, left.start, right.end);
  const populated = sampleRow.filter(hasValue).length;
  const gapStart = left.end + 1;
  const gapEnd = right.start - 1;
  if (
    gapEnd >= gapStart
    && gapEnd - gapStart + 1 <= 3
    && areSpacerColumns(sheetData, row, gapStart, gapEnd)
  ) {
    return populated >= Math.max(3, Math.ceil((right.end - left.start + 1) * 0.3));
  }
  return populated >= Math.max(3, Math.ceil((right.end - left.start + 1) * 0.5));
}

/**
 * A spacer column normally splits one header row into runs of the same table. Two
 * shapes break that rule: a grid whose columns repeat (a plate map, a layout form)
 * and a numbered axis such as 1..12 sitting beside labelled columns. Both are
 * separate blocks, so the runs stay apart.
 */
function runsAreSeparateBlocks(
  sheetData: ReturnType<typeof getSheetData>,
  row: number,
  left: { start: number; end: number },
  right: { start: number; end: number },
): boolean {
  if (hasRepeatedColumnRun(sheetData, row + 1, left.start, right.end)) return true;
  return isNumberedAxisRun(sheetData, row, left.start, left.end)
    && isLabelledHeaderRun(sheetData, row, right.start, right.end);
}

/**
 * True when `minRun` or more columns repeat the values of the column before them.
 * Record tables give every column its own sequence; grids copy whole columns, so a
 * run of identical columns marks a matrix rather than a record table.
 */
function hasRepeatedColumnRun(
  sheetData: ReturnType<typeof getSheetData>,
  startRow: number,
  startCol: number,
  endCol: number,
  minRun = 3,
  maxRows = 8,
): boolean {
  let repeats = 0;
  let previous: string[] | null = null;

  for (let col = startCol; col <= endCol; col++) {
    const values: string[] = [];
    for (let row = startRow; row < sheetData.rows && values.length < maxRows; row++) {
      const value = sheetData.data[row]?.[col];
      if (!hasValue(value)) break;
      values.push(stringifyValue(value));
    }

    const comparable = values.length >= 2 && values.some((value) => !isPlaceholderValue(value));
    const baseline = previous;
    const repeated = comparable
      && baseline !== null
      && values.length === baseline.length
      && values.every((value, index) => value === baseline[index]);
    repeats = repeated ? repeats + 1 : 0;
    if (repeats >= minRun - 1) return true;
    previous = comparable ? values : null;
  }

  return false;
}

/** A numbered axis such as the 1..12 header of a plate grid. */
function isNumberedAxisRun(
  sheetData: ReturnType<typeof getSheetData>,
  row: number,
  startCol: number,
  endCol: number,
): boolean {
  const values = collectRowValues(sheetData, row, startCol, endCol).filter(hasValue);
  const width = endCol - startCol + 1;
  if (values.length < 4 || values.length < Math.ceil(width * 0.8)) return false;

  const numbers = values.map((value) => Number(stringifyValue(value)));
  if (numbers.some((value) => !Number.isFinite(value))) return false;
  return numbers.every((value, index) => index === 0 || value === numbers[index - 1] + 1);
}

/** Every header cell in the run reads like a column name. */
function isLabelledHeaderRun(
  sheetData: ReturnType<typeof getSheetData>,
  row: number,
  startCol: number,
  endCol: number,
): boolean {
  let labelled = 0;
  for (let col = startCol; col <= endCol; col++) {
    const value = asString(sheetData.data[row]?.[col]);
    if (!value) continue;
    if (!isLikelyLabel(value)) return false;
    labelled += 1;
  }
  return labelled >= 2;
}

function coalesceRunsAcrossSpacers(
  sheetData: ReturnType<typeof getSheetData>,
  row: number,
  runs: Array<{ start: number; end: number; length: number; values: string[] }>,
): Array<{ start: number; end: number; length: number; values: string[] }> {
  if (runs.length <= 1) return runs;

  const merged: Array<{ start: number; end: number; length: number; values: string[] }> = [];
  let current = { ...runs[0] };

  for (let index = 1; index < runs.length; index++) {
    const next = runs[index];
    const gap = next.start - current.end - 1;

    if (
      gap <= 3
      && gap >= 1
      && areSpacerColumns(sheetData, row, current.end + 1, next.start - 1)
      && shouldMergeHeaderRuns(sheetData, row, current, next)
    ) {
      const combinedValues = (sheetData.data[row] ?? [])
        .slice(current.start, next.end + 1)
        .map((cell) => stringifyValue(cell));
      current = {
        start: current.start,
        end: next.end,
        length: next.end - current.start + 1,
        values: combinedValues,
      };
      continue;
    }

    merged.push(current);
    current = { ...next };
  }

  merged.push(current);
  return merged;
}

function measureTableDepth(
  sheetData: ReturnType<typeof getSheetData>,
  startRow: number,
  startCol: number,
  endCol: number,
): number {
  return measureTableBlock(sheetData, startRow, startCol, endCol, 0).depth;
}

/**
 * Measure the populated block under a header row. Spacer rows (single blank rows
 * inside an otherwise populated block) are skipped rather than ending the block,
 * so tables that separate sections with a blank row keep their real depth. Rows of
 * placeholder filler (N/A and friends) count as spacer rows too: they pad a block
 * without describing it.
 */
function measureTableBlock(
  sheetData: ReturnType<typeof getSheetData>,
  startRow: number,
  startCol: number,
  endCol: number,
  spacerRows: number,
): { depth: number; endRow: number } {
  const width = endCol - startCol + 1;
  const threshold = Math.max(1, Math.ceil(width * 0.4));
  let depth = 0;
  let endRow = startRow - 1;
  let consecutiveBlank = 0;

  for (let row = startRow; row < sheetData.rows; row++) {
    const populated = populatedInRange(sheetData, row, startCol, endCol);
    if (populated < threshold || meaningfulInRange(sheetData, row, startCol, endCol) === 0) {
      consecutiveBlank += 1;
      if (consecutiveBlank > spacerRows) break;
      continue;
    }
    consecutiveBlank = 0;
    depth += 1;
    endRow = row;
  }

  return { depth, endRow };
}

/**
 * Rows below a header that populate the run's first column. A table may leave its
 * other columns empty ("Extract. Assay ID | IPC-EX Sample ID | TqM-Int-Dup-XXX" with
 * only the first column filled in), so the first column is measured on its own.
 */
function measureFirstColumnBlock(
  sheetData: ReturnType<typeof getSheetData>,
  startRow: number,
  startCol: number,
): { depth: number; endRow: number } {
  let depth = 0;
  let endRow = startRow - 1;

  // Strict: the first column has to run without gaps, so a blank row ends the block
  // instead of bridging into whatever table sits underneath. Placeholder filler does
  // not count either.
  for (let row = startRow; row < sheetData.rows; row++) {
    if (!hasOwnValue(sheetData, row, startCol) || isPlaceholderValue(sheetData.data[row]?.[startCol])) break;
    depth += 1;
    endRow = row;
  }

  return { depth, endRow };
}

type ValueClass = 'number' | 'date' | 'bool' | 'identifier' | 'label' | 'other';

/** Coarse class of a cell value, used to tell a table column from a key/value block. */
function classifyValue(value: CellValue | undefined): ValueClass | null {
  if (value === null || value === undefined) return null;
  if (!hasValue(value) || isPlaceholderValue(value)) return null;

  const inferred = inferFieldType(value);
  if (inferred === 'int' || inferred === 'float') return 'number';
  if (inferred === 'date') return 'date';
  if (inferred === 'bool') return 'bool';

  const text = stringifyValue(value);
  if (looksTimeLike(text)) return 'date';
  if (looksIdentifierLike(text)) return 'identifier';
  if (looksDataLikeLabel(text)) return 'other';
  if (isLikelyLabel(text)) return 'label';
  return 'other';
}

function looksTimeLike(value: string): boolean {
  return /^\d{1,2}:\d{2}(:\d{2})?$/.test(value.trim());
}

interface RowProfile {
  nonBlank: number;
  labelLike: number;
  dataLike: number;
  typed: number;
  emphasized: number;
  labelRatio: number;
  emphasisRatio: number;
  typedClass: ValueClass | null;
}

function profileRow(
  sheetData: ReturnType<typeof getSheetData>,
  row: number,
  startCol: number,
  endCol: number,
): RowProfile {
  let nonBlank = 0;
  let labelLike = 0;
  let dataLike = 0;
  let typed = 0;
  let emphasized = 0;
  const typedCounts = new Map<ValueClass, number>();

  for (let col = startCol; col <= endCol; col++) {
    const value = sheetData.data[row]?.[col];
    if (!hasValue(value)) continue;
    nonBlank += 1;

    if (looksEmphasizedStrongly(sheetData.cells[row]?.[col]?.style)) emphasized += 1;

    const text = stringifyValue(value);
    const isData = looksDataLikeLabel(text) || looksStatusLike(text);
    if (isData) dataLike += 1;
    else if (isLikelyLabel(text)) labelLike += 1;

    const valueClass = classifyValue(value);
    if (valueClass === 'number' || valueClass === 'date' || valueClass === 'bool') {
      typed += 1;
      typedCounts.set(valueClass, (typedCounts.get(valueClass) ?? 0) + 1);
    }
  }

  const dominant = [...typedCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  const typedClass = dominant && typed > 0 && dominant[1] >= Math.ceil(typed * 0.7) ? dominant[0] : null;

  return {
    nonBlank,
    labelLike,
    dataLike,
    typed,
    emphasized,
    labelRatio: nonBlank ? labelLike / nonBlank : 0,
    emphasisRatio: nonBlank ? emphasized / nonBlank : 0,
    typedClass,
  };
}

/** Average label-ness and emphasis of the rows under a candidate header row. */
function profileRowsBelow(
  sheetData: ReturnType<typeof getSheetData>,
  startRow: number,
  startCol: number,
  endCol: number,
  maxRows = 5,
): { labelRatio: number; emphasisRatio: number; rows: number } {
  const width = endCol - startCol + 1;
  const threshold = Math.max(1, Math.ceil(width * 0.4));
  let rows = 0;
  let labelTotal = 0;
  let emphasisTotal = 0;
  let nonBlankTotal = 0;

  for (let row = startRow; row < sheetData.rows && rows < maxRows; row++) {
    let populated = 0;
    for (let col = startCol; col <= endCol; col++) {
      if (hasValue(sheetData.data[row]?.[col])) populated += 1;
    }
    if (populated < threshold) break;

    const profile = profileRow(sheetData, row, startCol, endCol);
    labelTotal += profile.labelLike;
    emphasisTotal += profile.emphasized;
    nonBlankTotal += profile.nonBlank;
    rows += 1;
  }

  return {
    labelRatio: nonBlankTotal ? labelTotal / nonBlankTotal : 0,
    emphasisRatio: nonBlankTotal ? emphasisTotal / nonBlankTotal : 0,
    rows,
  };
}

interface ColumnProfile {
  headerClass: ValueClass | null;
  dominantClass: ValueClass | null;
  judged: boolean;
  consistent: boolean;
}

/**
 * Classify the values under a candidate header row per column. Real tables keep a
 * single value class per column; key/value blocks and layout forms mix classes
 * down the same column.
 */
function profileColumnsBelow(
  sheetData: ReturnType<typeof getSheetData>,
  headerRow: number,
  startCol: number,
  endCol: number,
  maxRows = 10,
): ColumnProfile[] {
  const profiles: ColumnProfile[] = [];

  for (let col = startCol; col <= endCol; col++) {
    const counts = new Map<ValueClass, number>();
    let sampled = 0;

    for (let row = headerRow + 1; row < sheetData.rows && sampled < maxRows; row++) {
      const value = sheetData.data[row]?.[col];
      if (!hasValue(value)) break;
      const valueClass = classifyValue(value);
      if (!valueClass) continue;
      counts.set(valueClass, (counts.get(valueClass) ?? 0) + 1);
      sampled += 1;
    }

    const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
    const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    profiles.push({
      headerClass: classifyValue(sheetData.data[headerRow]?.[col]),
      dominantClass: dominant?.[0] ?? null,
      judged: total >= 2,
      consistent: total >= 2 && Boolean(dominant) && dominant[1] / total >= 0.7,
    });
  }

  return profiles;
}

function columnsLookConsistent(columns: ColumnProfile[]): boolean {
  const judged = columns.filter((column) => column.judged);
  if (judged.length < 2) return true;
  const inconsistent = judged.filter((column) => !column.consistent).length;
  return inconsistent < Math.ceil(judged.length * 0.5);
}

/**
 * A group header row labels a span of columns. The span is either a merged cell or
 * the same label repeated across adjacent cells. When distinct column names sit
 * underneath the span, the real headers are on the row below, so this row is not a
 * usable header row.
 */
function hasGroupHeaderRow(
  sheetData: ReturnType<typeof getSheetData>,
  row: number,
  startCol: number,
  endCol: number,
): boolean {
  for (let col = startCol; col <= endCol; col++) {
    const merge = sheetData.cells[row]?.[col]?.merge;
    let spanEnd = merge && merge.right > merge.left
      ? Math.min(merge.right, endCol)
      : col;

    if (spanEnd === col) {
      const text = stringifyValue(sheetData.data[row]?.[col]);
      if (!text) continue;
      while (
        spanEnd + 1 <= endCol
        && stringifyValue(sheetData.data[row]?.[spanEnd + 1]) === text
      ) {
        spanEnd += 1;
      }
      if (spanEnd === col) continue;
    }

    const belowLabels = new Set<string>();
    let belowCells = 0;
    for (let inner = Math.max(col, startCol); inner <= spanEnd; inner++) {
      const text = asString(sheetData.data[row + 1]?.[inner]);
      if (!text) continue;
      belowCells += 1;
      if (isKeyValueLabel(text)) belowLabels.add(text);
    }

    // Several distinct labels underneath the span mean the row below holds the real
    // column names. Data underneath means the label is the column name itself.
    if (belowCells > 0 && belowLabels.size >= 2) return true;
    col = spanEnd;
  }
  return false;
}

/**
 * Decide whether a row can serve as a table header. A header row has to stand out
 * from the rows below it: either it reads as labels while they do not, or it is
 * visually emphasized, or it holds repeated typed values (dates, years) that
 * differ from the values in the columns underneath.
 */
function assessHeaderRow(
  sheetData: ReturnType<typeof getSheetData>,
  row: number,
  startCol: number,
  endCol: number,
): { ok: boolean; kind: 'labels' | 'typed' | null; columns: ColumnProfile[] | null } {
  const rejected = { ok: false, kind: null, columns: null } as const;
  const profile = profileRow(sheetData, row, startCol, endCol);
  if (profile.nonBlank < 2) return rejected;
  if (hasGroupHeaderRow(sheetData, row, startCol, endCol)) return rejected;

  const labelsCandidate = profile.labelLike >= Math.max(2, Math.ceil(profile.nonBlank * 0.6))
    && profile.dataLike <= profile.labelLike;
  const typedCandidate = profile.typedClass !== null
    && profile.typed >= Math.max(2, Math.ceil(profile.nonBlank * 0.7));
  if (!labelsCandidate && !typedCandidate) return rejected;

  const startsBlock = !rowAboveIsBlock(sheetData, row, startCol, endCol);

  if (labelsCandidate) {
    const below = startsBlock ? null : profileRowsBelow(sheetData, row + 1, startCol, endCol);
    const labelMargin = below ? profile.labelRatio - below.labelRatio : 0;
    const emphasisMargin = below ? profile.emphasisRatio - below.emphasisRatio : 0;
    if (startsBlock || labelMargin >= 0.2 || emphasisMargin >= 0.25) {
      const columns = profileColumnsBelow(sheetData, row, startCol, endCol);
      return columnsLookConsistent(columns) ? { ok: true, kind: 'labels', columns } : rejected;
    }
  }

  if (typedCandidate) {
    const below = profileRowsBelow(sheetData, row + 1, startCol, endCol);
    const emphasisMargin = profile.emphasisRatio - below.emphasisRatio;
    const divergent = quickDivergentColumns(sheetData, row, startCol, endCol);
    const diverges = divergent >= Math.ceil(profile.nonBlank * 0.6);
    // Years or periods that run in order label a series of columns.
    const ordered = startsBlock && isOrderedTypedRun(sheetData, row, startCol, endCol);
    if (!diverges && emphasisMargin < 0.25 && !ordered) return rejected;

    const columns = profileColumnsBelow(sheetData, row, startCol, endCol);
    if (!columnsLookConsistent(columns)) return rejected;
    return { ok: true, kind: 'typed', columns };
  }

  return rejected;
}

/** True when the row above fills the same columns, so this row is inside a block. */
function rowAboveIsBlock(
  sheetData: ReturnType<typeof getSheetData>,
  row: number,
  startCol: number,
  endCol: number,
): boolean {
  if (row <= 0) return false;

  const width = endCol - startCol + 1;
  let populated = 0;
  let mergedSpan = 0;

  for (let col = startCol; col <= endCol; col++) {
    if (hasValue(sheetData.data[row - 1]?.[col])) populated += 1;
    const merge = sheetData.cells[row - 1]?.[col]?.merge;
    if (merge && merge.right > merge.left) mergedSpan += 1;
  }

  // A merged title band above the header is not part of the table block.
  if (mergedSpan >= Math.ceil(width * 0.6)) return false;
  return populated >= Math.ceil(width * 0.6);
}

/**
 * Cheap divergence check: how many columns hold a different value class than the
 * first value underneath them. Data rows repeat their column's class; date or year
 * headers do not.
 */
function quickDivergentColumns(
  sheetData: ReturnType<typeof getSheetData>,
  row: number,
  startCol: number,
  endCol: number,
): number {
  let divergent = 0;
  for (let col = startCol; col <= endCol; col++) {
    const headerClass = classifyValue(sheetData.data[row]?.[col]);
    if (headerClass === null) continue;
    for (let below = row + 1; below < sheetData.rows; below += 1) {
      const belowClass = classifyValue(sheetData.data[below]?.[col]);
      if (belowClass === null) continue;
      if (belowClass !== headerClass) divergent += 1;
      break;
    }
  }
  return divergent;
}

/** Unique typed values that increase or decrease across a row: years, periods. */
function isOrderedTypedRun(
  sheetData: ReturnType<typeof getSheetData>,
  row: number,
  startCol: number,
  endCol: number,
): boolean {
  const values: number[] = [];

  for (let col = startCol; col <= endCol; col++) {
    const value = sheetData.data[row]?.[col];
    if (!hasValue(value)) continue;
    const numeric = typeof value === 'number' ? value : Number(stringifyValue(value));
    if (!Number.isFinite(numeric)) continue;
    values.push(numeric);
  }
  if (values.length < 3 || values.length < Math.ceil((endCol - startCol + 1) * 0.6)) return false;

  const increasing = values.every((value, index) => index === 0 || value > values[index - 1]);
  const decreasing = values.every((value, index) => index === 0 || value < values[index - 1]);
  return increasing || decreasing;
}

/** Build the column-letter to field-name mapping, keeping blank columns aligned. */
function buildTableColumns(rawHeaders: string[], startCol: number): Record<string, string> {
  const entries = rawHeaders
    .map((header, index) => ({ header, index }))
    .filter((entry) => Boolean(entry.header));
  const names = disambiguateHeaders(entries.map((entry) => entry.header));
  return Object.fromEntries(
    entries.map((entry, index) => [columnLetter(startCol + entry.index), names[index]]),
  );
}

/**
 * True when the whole run is one merged region. A band such as "Supplementary
 * Pages" spans the sheet to group what follows; its text is a title, not a row of
 * column names, so it never becomes a table header.
 */
function isSectionBand(
  sheetData: ReturnType<typeof getSheetData>,
  row: number,
  startCol: number,
  endCol: number,
): boolean {
  if (endCol <= startCol) return false;

  for (let col = startCol; col <= endCol; col++) {
    const merge = sheetData.cells[row]?.[col]?.merge;
    if (!merge || merge.right <= merge.left) return false;
    if (merge.left !== startCol || merge.right !== endCol) return false;
  }

  return true;
}

/** A run of cells merged into one region is a single title, not a repeated sequence. */
function isMergedAcrossColumns(
  sheetData: ReturnType<typeof getSheetData>,
  row: number,
  startCol: number,
  endCol: number,
): boolean {
  for (let col = startCol; col <= endCol; col++) {
    const merge = sheetData.cells[row]?.[col]?.merge;
    if (merge && merge.right > merge.left) return true;
  }
  return false;
}

/**
 * A column of values paired with a populated column beside it is part of a block
 * (a table or key/value pairs) rather than a standalone list field.
 */
function isBlockColumn(
  sheetData: ReturnType<typeof getSheetData>,
  startRow: number,
  col: number,
  depth: number,
): boolean {
  return [col - 1, col + 1].some((neighbour) => (
    neighbour >= 0 && isPairedColumn(sheetData, startRow, neighbour, depth)
  ));
}

/**
 * A row of values with a populated row directly above or below the same columns
 * is part of a block rather than a standalone list field.
 */
function isBlockRow(
  sheetData: ReturnType<typeof getSheetData>,
  row: number,
  startCol: number,
  endCol: number,
): boolean {
  return [row - 1, row + 1].some((neighbour) => {
    if (neighbour < 0 || neighbour >= sheetData.rows) return false;
    const populated = populatedInRange(sheetData, neighbour, startCol, endCol);
    return populated >= Math.ceil((endCol - startCol + 1) * 0.6);
  });
}

function isPairedColumn(
  sheetData: ReturnType<typeof getSheetData>,
  startRow: number,
  neighbourCol: number,
  depth: number,
): boolean {
  const populated = populatedInColumnRange(sheetData, neighbourCol, startRow, startRow + depth - 1);
  return populated >= Math.ceil(depth * 0.6);
}

/** Stronger emphasis signal than borders alone, so bordered data rows do not count. */
function looksEmphasizedStrongly(style: CellInfo['style'] | undefined): boolean {
  return Boolean(style?.bold || style?.bgColor);
}

function areSpacerColumns(
  sheetData: ReturnType<typeof getSheetData>,
  headerRow: number,
  startCol: number,
  endCol: number,
): boolean {
  const maxRow = Math.min(sheetData.rows - 1, headerRow + 4);
  for (let row = headerRow; row <= maxRow; row++) {
    for (let col = startCol; col <= endCol; col++) {
      if (hasValue(sheetData.data[row]?.[col])) {
        return false;
      }
    }
  }
  return true;
}

interface DepthTables {
  vertical: number[][];
  horizontal: number[][];
}

/**
 * Consecutive populated cells from every position, in both directions. Without
 * this the range scan walks each column and row to its end for every cell, which
 * is quadratic on large sheets.
 */
function buildDepthTables(sheetData: ReturnType<typeof getSheetData>): DepthTables | null {
  if (sheetData.rows * sheetData.cols > 4_000_000) return null;

  const vertical: number[][] = [];
  for (let col = 0; col < sheetData.cols; col++) {
    const column = new Array<number>(sheetData.rows).fill(0);
    for (let row = sheetData.rows - 1; row >= 0; row -= 1) {
      column[row] = hasValue(sheetData.data[row]?.[col]) ? (column[row + 1] ?? 0) + 1 : 0;
    }
    vertical.push(column);
  }

  const horizontal: number[][] = [];
  for (let row = 0; row < sheetData.rows; row++) {
    const rowDepths = new Array<number>(sheetData.cols).fill(0);
    for (let col = sheetData.cols - 1; col >= 0; col -= 1) {
      rowDepths[col] = hasValue(sheetData.data[row]?.[col]) ? (rowDepths[col + 1] ?? 0) + 1 : 0;
    }
    horizontal.push(rowDepths);
  }

  return { vertical, horizontal };
}

function depthAt(
  depths: DepthTables | null,
  axis: 'vertical' | 'horizontal',
  sheetData: ReturnType<typeof getSheetData>,
  row: number,
  col: number,
): number {
  if (depths) {
    const table = axis === 'vertical' ? depths.vertical : depths.horizontal;
    return table[axis === 'vertical' ? col : row]?.[axis === 'vertical' ? row : col] ?? 0;
  }
  return measureLinearDepth(sheetData, row, col, axis);
}

function measureLinearDepth(
  sheetData: ReturnType<typeof getSheetData>,
  startRow: number,
  startCol: number,
  axis: 'vertical' | 'horizontal',
): number {
  let depth = 0;

  while (true) {
    const row = axis === 'vertical' ? startRow + depth : startRow;
    const col = axis === 'horizontal' ? startCol + depth : startCol;
    if (row >= sheetData.rows || col >= sheetData.cols) break;
    if (!hasValue(sheetData.data[row]?.[col])) break;
    depth += 1;
  }

  return depth;
}

function collectLinearValues(
  sheetData: ReturnType<typeof getSheetData>,
  startRow: number,
  startCol: number,
  axis: 'vertical' | 'horizontal',
  depth: number,
): CellValue[] {
  const values: CellValue[] = [];

  for (let index = 0; index < depth; index++) {
    const row = axis === 'vertical' ? startRow + index : startRow;
    const col = axis === 'horizontal' ? startCol + index : startCol;
    values.push(sheetData.data[row]?.[col] ?? null);
  }

  return values;
}

function collectRowValues(
  sheetData: ReturnType<typeof getSheetData>,
  row: number,
  startCol: number,
  endCol: number,
): CellValue[] {
  const values: CellValue[] = [];
  for (let col = startCol; col <= endCol; col++) {
    values.push(sheetData.data[row]?.[col] ?? null);
  }
  return values;
}

interface SheetScanCaches {
  runs: Map<number, ReturnType<typeof findNonEmptyRuns>>;
  depths: Map<string, number>;
  /** Per row prefix sums of populated cells, so range counts are O(1). */
  populatedPrefix: number[][] | null;
  /** Per column prefix sums of populated cells, so column counts are O(1). */
  populatedColumnPrefix: number[][] | null;
  /** Per row prefix sums of populated cells that hold more than a placeholder. */
  meaningfulPrefix: number[][] | null;
}

/**
 * Runs and block depths are asked for once per cell, so they are cached per sheet
 * for the duration of a scan. The cache hangs off the sheet data, which is rebuilt
 * for every scan.
 */
const sheetScanCaches = new WeakMap<ReturnType<typeof getSheetData>, SheetScanCaches>();

function getSheetScanCaches(sheetData: ReturnType<typeof getSheetData>): SheetScanCaches {
  let caches = sheetScanCaches.get(sheetData);
  if (!caches) {
    caches = { runs: new Map(), depths: new Map(), populatedPrefix: null, populatedColumnPrefix: null, meaningfulPrefix: null };
    sheetScanCaches.set(sheetData, caches);
  }
  return caches;
}

/** Count of populated cells in a row between two columns, using prefix sums. */
function populatedInRange(
  sheetData: ReturnType<typeof getSheetData>,
  row: number,
  startCol: number,
  endCol: number,
): number {
  const caches = getSheetScanCaches(sheetData);
  if (!caches.populatedPrefix) {
    caches.populatedPrefix = sheetData.data.map((rowValues) => {
      const prefix = new Array<number>(sheetData.cols + 1).fill(0);
      for (let col = 0; col < sheetData.cols; col += 1) {
        prefix[col + 1] = prefix[col] + (hasValue(rowValues?.[col]) ? 1 : 0);
      }
      return prefix;
    });
  }

  const prefix = caches.populatedPrefix[row];
  if (!prefix) return 0;
  const from = prefix[Math.max(0, startCol)] ?? 0;
  const to = prefix[Math.min(sheetData.cols, endCol + 1)] ?? 0;
  return to - from;
}

/**
 * Count of populated cells in a row that hold more than a placeholder. A row of
 * N/A filler does not extend a table the way real values do.
 */
function meaningfulInRange(
  sheetData: ReturnType<typeof getSheetData>,
  row: number,
  startCol: number,
  endCol: number,
): number {
  const caches = getSheetScanCaches(sheetData);
  if (!caches.meaningfulPrefix) {
    caches.meaningfulPrefix = sheetData.data.map((rowValues) => {
      const prefix = new Array<number>(sheetData.cols + 1).fill(0);
      for (let col = 0; col < sheetData.cols; col += 1) {
        const value = rowValues?.[col];
        const meaningful = hasValue(value) && !isPlaceholderValue(value);
        prefix[col + 1] = prefix[col] + (meaningful ? 1 : 0);
      }
      return prefix;
    });
  }

  const prefix = caches.meaningfulPrefix[row];
  if (!prefix) return 0;
  const from = prefix[Math.max(0, startCol)] ?? 0;
  const to = prefix[Math.min(sheetData.cols, endCol + 1)] ?? 0;
  return to - from;
}

/** Count of populated cells in a column between two rows, using prefix sums. */
function populatedInColumnRange(
  sheetData: ReturnType<typeof getSheetData>,
  col: number,
  startRow: number,
  endRow: number,
): number {
  if (col < 0 || col >= sheetData.cols) return 0;

  const caches = getSheetScanCaches(sheetData);
  if (!caches.populatedColumnPrefix) {
    const columns: number[][] = [];
    for (let currentCol = 0; currentCol < sheetData.cols; currentCol += 1) {
      const prefix = new Array<number>(sheetData.rows + 1).fill(0);
      for (let row = 0; row < sheetData.rows; row += 1) {
        prefix[row + 1] = prefix[row] + (hasValue(sheetData.data[row]?.[currentCol]) ? 1 : 0);
      }
      columns.push(prefix);
    }
    caches.populatedColumnPrefix = columns;
  }

  const prefix = caches.populatedColumnPrefix[col];
  if (!prefix) return 0;
  const from = prefix[Math.max(0, startRow)] ?? 0;
  const to = prefix[Math.min(sheetData.rows, endRow + 1)] ?? 0;
  return to - from;
}

function detectHeaderBand(
  sheetData: ReturnType<typeof getSheetData>,
  row: number,
  col: number,
): HeaderBand | null {
  const caches = getSheetScanCaches(sheetData);

  let runs = caches.runs.get(row);
  if (!runs) {
    runs = findNonEmptyRuns(sheetData.data[row] ?? [], sheetData.hiddenCols);
    caches.runs.set(row, runs);
  }

  const run = runs.find((candidate) => col >= candidate.start && col <= candidate.end);
  if (!run || run.length < 4) return null;

  const key = `${row}:${run.start}:${run.end}`;
  let depth = caches.depths.get(key);
  if (depth === undefined) {
    depth = measureTableDepth(sheetData, row + 1, run.start, run.end);
    caches.depths.set(key, depth);
  }

  return {
    startCol: run.start,
    endCol: run.end,
    width: run.length,
    depth,
  };
}

function suggestTableName(
  sheetData: ReturnType<typeof getSheetData>,
  headerRow: number,
  startCol: number,
  endCol: number,
  headers: string[],
): string {
  const sectionTitle = findNearbySectionTitle(sheetData, headerRow, startCol, endCol);
  if (sectionTitle) {
    const fromTitle = slugify(sectionTitle);
    if (fromTitle) return `${fromTitle}_table`;
  }

  const above = asString(sheetData.data[headerRow - 1]?.[startCol]);
  if (above && isLikelyLabel(above)) {
    const fromAbove = slugify(cleanLabel(above));
    if (fromAbove) return `${fromAbove}_table`;
  }

  const firstHeader = slugify(headers[0] ?? '');
  const sheet = slugify(sheetData.name);
  if (firstHeader) return `${firstHeader}_table`;
  if (sheet) return `${sheet}_table`;
  return '';
}

function findNearbySectionTitle(
  sheetData: ReturnType<typeof getSheetData>,
  headerRow: number,
  startCol: number,
  endCol: number,
): string | null {
  const minRow = Math.max(0, headerRow - 6);
  const candidates: Array<{ text: string; row: number }> = [];

  for (let row = headerRow - 1; row >= minRow; row--) {
    const firstCol = Math.max(0, startCol - 2);
    const lastCol = Math.min(sheetData.cols - 1, endCol);
    // A cover block is its own header, so its labels and values never name a table.
    const coverAbove = detectCoverBlock(sheetData, row - 1);
    const coverHere = detectCoverBlock(sheetData, row);
    // A title sits alone in its row; a populated band is another table's header.
    if (distinctPopulatedCells(sheetData, row, firstCol, lastCol) > 1) continue;

    for (let col = firstCol; col <= lastCol; col++) {
      if (coverAbove?.valueCols.includes(col) || coverHere?.labelCols.includes(col)) continue;
      const text = asString(sheetData.data[row]?.[col]);
      if (!text) continue;
      const cleaned = normalizeSectionTitle(text);
      if (!cleaned) continue;
      candidates.push({ text: cleaned, row });
    }
  }

  candidates.sort((a, b) => {
    const rowDistance = b.row - a.row;
    if (rowDistance !== 0) return rowDistance;
    return b.text.length - a.text.length;
  });

  return candidates[0]?.text ?? null;
}

/** Populated cells in a row, counting a merged region once. */
function distinctPopulatedCells(
  sheetData: ReturnType<typeof getSheetData>,
  row: number,
  startCol: number,
  endCol: number,
): number {
  let count = 0;

  for (let col = startCol; col <= endCol; col++) {
    if (!hasValue(sheetData.data[row]?.[col])) continue;
    const merge = sheetData.cells[row]?.[col]?.merge;
    if (merge && merge.right > merge.left && col > merge.left) continue;
    count += 1;
  }

  return count;
}

/**
 * Keep generated names unique across the suggestion list and any existing fields:
 * tables are renamed with a suffix, fields are dropped because their name comes
 * from the sheet.
 */
function disambiguateSuggestionNames(
  suggestions: SchemaSuggestion[],
  existingNames: Set<string>,
): SchemaSuggestion[] {
  const used = new Set(existingNames);
  const result: SchemaSuggestion[] = [];

  for (const suggestion of suggestions) {
    if (suggestion.kind !== 'table' && suggestion.kind !== 'field') {
      result.push(suggestion);
      continue;
    }

    const name = suggestion.field.name;
    if (!used.has(name)) {
      used.add(name);
      result.push(suggestion);
      continue;
    }

    // A field name comes from the sheet, so a clash drops the suggestion; a table
    // name is generated, so it can take a suffix.
    if (suggestion.kind === 'field') continue;

    let index = 2;
    while (used.has(`${name}_${index}`)) index += 1;
    const renamed = `${name}_${index}`;
    used.add(renamed);
    result.push({ ...suggestion, field: { ...suggestion.field, name: renamed } });
  }

  return result;
}

function collectExistingRefs(
  workbook: Workbook,
  defaultSheet: string,
  fields: StencilField[] | undefined,
): ParsedRef[] {
  return (fields ?? [])
    .map((field) => parseStencilRef(field.cell ?? field.range, defaultSheet))
    .filter((entry): entry is ParsedRef => entry !== null)
    // A field whose cell is empty in this workbook does not describe it (the schema
    // was authored against another file), so it must not hide suggestions.
    .filter((entry) => hasValue(getCellValue(
      workbook,
      entry.sheetName,
      formatRange({ row: entry.startRow, col: entry.startCol }, { row: entry.startRow, col: entry.startCol }),
    )));
}

function refOverlapsExisting(ref: string, defaultSheet: string, existingRefs: ParsedRef[]): boolean {
  const parsed = parseStencilRef(ref, defaultSheet);
  if (!parsed) return false;
  return existingRefs.some((existing) => refsOverlap(existing, parsed));
}

/**
 * Drop the suggestions a field already answers. Mapping a range by hand (drawing a
 * selection and saving it) leaves the card that proposed the same region behind, so
 * the list is pruned whenever a field is saved.
 *
 * A field and a suggestion answer the same region when each one's first cell falls
 * inside the other. Comparing anchors instead of containment matters for open-ended
 * fields: "A23:F" runs to the bottom of the sheet, and containment would retire every
 * card below it.
 */
export function dropSuggestionsCoveredBy(
  suggestions: SchemaSuggestion[],
  fields: StencilField[],
  defaultSheet: string,
): SchemaSuggestion[] {
  if (suggestions.length === 0 || fields.length === 0) return suggestions;

  const fieldRefs = fields
    .map((field) => parseStencilRef(field.range ?? field.cell, defaultSheet))
    .filter((ref): ref is ParsedRef => ref !== null);
  if (fieldRefs.length === 0) return suggestions;

  return suggestions.filter((suggestion) => {
    const bounds = parseSuggestionRef(suggestion);
    if (!bounds) return true;
    return !fieldRefs.some((field) => (
      refsContain(field, { ...bounds, endRow: bounds.startRow, endCol: bounds.startCol })
      && refsContain(bounds, { ...field, endRow: field.startRow, endCol: field.startCol })
    ));
  });
}

function parseSuggestionRef(suggestion: SchemaSuggestion): ParsedRef | null {
  if (suggestion.bounds) return suggestion.bounds;
  if (suggestion.kind === 'discriminator') {
    return parseStencilRef(suggestion.cellRef, suggestion.sheetName);
  }
  return parseStencilRef(suggestion.field.cell ?? suggestion.field.range, suggestion.sheetName);
}

function parseStencilRef(ref: string | undefined, defaultSheet: string): ParsedRef | null {
  if (!ref) return null;
  const [sheetMaybe, value] = splitSheetRef(ref);
  const sheetName = value ? (sheetMaybe ?? defaultSheet) : defaultSheet;
  const bare = value ?? ref;
  const [startRef, endRefMaybe] = bare.split(':');
  if (!startRef) return null;

  try {
    const start = parseAddress(startRef.toUpperCase());
    if (!endRefMaybe) {
      return {
        sheetName,
        startRow: start.row,
        endRow: start.row,
        startCol: start.col,
        endCol: start.col,
      };
    }

    if (/^[A-Z]+$/.test(endRefMaybe.toUpperCase())) {
      const endCol = parseAddress(`${endRefMaybe.toUpperCase()}${start.row + 1}`).col;
      return {
        sheetName,
        startRow: start.row,
        endRow: Number.MAX_SAFE_INTEGER,
        startCol: Math.min(start.col, endCol),
        endCol: Math.max(start.col, endCol),
      };
    }

    const end = parseAddress(endRefMaybe.toUpperCase());
    return {
      sheetName,
      startRow: Math.min(start.row, end.row),
      endRow: Math.max(start.row, end.row),
      startCol: Math.min(start.col, end.col),
      endCol: Math.max(start.col, end.col),
    };
  } catch {
    return null;
  }
}

function splitSheetRef(ref: string): [string | undefined, string | undefined] {
  const idx = ref.indexOf('!');
  if (idx < 0) return [undefined, ref];
  return [ref.slice(0, idx), ref.slice(idx + 1)];
}

function refsOverlap(a: ParsedRef, b: ParsedRef): boolean {
  return a.sheetName === b.sheetName
    && a.startRow <= b.endRow
    && b.startRow <= a.endRow
    && a.startCol <= b.endCol
    && b.startCol <= a.endCol;
}

/** True when `outer` spans every cell of `inner`. */
function refsContain(outer: ParsedRef, inner: ParsedRef): boolean {
  return outer.sheetName === inner.sheetName
    && outer.startRow <= inner.startRow
    && outer.endRow >= inner.endRow
    && outer.startCol <= inner.startCol
    && outer.endCol >= inner.endCol;
}

function suggestionPriority(suggestion: SchemaSuggestion): number {
  if (suggestion.kind === 'table') return 3;
  if (suggestion.kind === 'discriminator') return 2;
  return 1;
}

function suggestionArea(suggestion: SchemaSuggestion): number {
  const parsed = parseSuggestionRef(suggestion);
  if (!parsed) return 0;
  return (parsed.endRow - parsed.startRow + 1) * (parsed.endCol - parsed.startCol + 1);
}

function compareSuggestions(a: SchemaSuggestion, b: SchemaSuggestion): number {
  const kindWeight = suggestionPriority(b) - suggestionPriority(a);
  if (kindWeight !== 0) return kindWeight;

  if (a.kind === 'table' && b.kind === 'table') {
    const scoreDelta = b.score - a.score;
    if (Math.abs(scoreDelta) > 0.04) return scoreDelta;
    const areaDelta = suggestionArea(b) - suggestionArea(a);
    if (areaDelta !== 0) return areaDelta;
    return scoreDelta;
  }

  return b.score - a.score;
}

function cleanLabel(text: string): string {
  return text
    .replace(/[:*]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSectionTitle(text: string): string | null {
  const normalized = cleanLabel(
    text
      .replace(/^table\s+\d+\s*:\s*/i, '')
      .replace(/^section\s+\d+\s*:\s*/i, ''),
  );
  if (!normalized) return null;
  if (normalized.length < 6 || normalized.length > 64) return null;
  if (!/[a-z]/i.test(normalized)) return null;
  // A title that reads like an identifier is a value, not a heading.
  if (looksIdentifierLike(normalized)) return null;
  if (/^hidden table\b/i.test(text.trim())) return null;
  if (/^(if|sum|mid|left|right|vlookup|xlookup|index|match|offset)\s*\(/i.test(normalized)) return null;
  if (/[=()]/.test(normalized)) return null;
  return normalized;
}

function inferFieldType(value: CellValue): StencilField['type'] | 'str' {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'int' : 'float';
  }
  if (typeof value === 'boolean') {
    return 'bool';
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^(true|false|yes|no)$/i.test(trimmed)) return 'bool';
    if (/^-?\d+$/.test(trimmed)) return 'int';
    if (/^-?\d+\.\d+$/.test(trimmed)) return 'float';
    if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(trimmed) || /^\d{4}-\d{1,2}-\d{1,2}$/.test(trimmed)) {
      return 'date';
    }
  }
  return 'str';
}

function inferListType(values: CellValue[]): StencilField['type'] {
  const inferred = values
    .map((value) => inferFieldType(value))
    .filter((value): value is 'int' | 'float' | 'bool' => (
      value === 'int' || value === 'float' || value === 'bool'
    ));

  if (inferred.length === 0) return 'list[str]';

  const counts = new Map<string, number>();
  for (const value of inferred) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (best === 'int') return 'list[int]';
  if (best === 'float') return 'list[float]';
  if (best === 'bool') return 'list[bool]';
  return 'list[str]';
}

function findLeadingPlaceholderOffset(values: CellValue[]): number {
  let offset = 0;
  while (offset < values.length - 2 && isPlaceholderValue(values[offset])) {
    offset += 1;
  }
  return offset;
}

function disambiguateHeaders(headers: string[]): string[] {
  const counts = new Map<string, number>();
  return headers.map((header) => {
    const base = slugify(header) || 'column';
    const seen = (counts.get(base) ?? 0) + 1;
    counts.set(base, seen);
    return seen === 1 ? base : `${base}_${seen}`;
  });
}

function looksVersionLike(value: string): boolean {
  return /^v?\d+([._-]\d+)*$/i.test(value.trim()) || /\b(rev|revision)\b/i.test(value);
}

function looksIdentifierLike(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.length > 64) return false;
  if (!/[a-z]/i.test(trimmed) || !/\d/.test(trimmed)) return false;
  return /^[a-z0-9._/\- ]+$/i.test(trimmed);
}

function looksStatusLike(value: string): boolean {
  const trimmed = value.trim().toUpperCase();
  if (!trimmed) return false;
  return trimmed === 'OK'
    || trimmed === 'NQ'
    || trimmed === 'CC'
    || trimmed === 'PASS'
    || trimmed === 'FAIL'
    || trimmed === 'NO'
    || trimmed === 'YES'
    || trimmed === 'NQ, CC';
}

function isLikelyHeaderCell(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (!isLikelyLabel(trimmed)) return false;
  if (looksDataLikeLabel(trimmed)) return false;
  if (looksStatusLike(trimmed)) return false;
  return true;
}

function looksEmphasizedAcrossRow(
  sheetData: ReturnType<typeof getSheetData>,
  row: number,
  startCol: number,
  endCol: number,
): boolean {
  let emphasized = 0;
  for (let col = startCol; col <= endCol; col++) {
    if (looksEmphasized(sheetData.cells[row]?.[col]?.style)) {
      emphasized += 1;
    }
  }
  return emphasized >= Math.max(1, Math.ceil((endCol - startCol + 1) * 0.4));
}

function shouldDropSuggestion(suggestion: SchemaSuggestion): boolean {
  if (suggestion.kind === 'table') {
    const name = suggestion.field.name.trim().toLowerCase();
    return name.startsWith('hidden_table_');
  }
  if (suggestion.kind !== 'field') return false;
  // A label of N/A names nothing, so the field it would create is noise.
  if (isPlaceholderValue(suggestion.sourceLabel)) return true;
  const name = suggestion.field.name.trim().toLowerCase();
  return (Boolean(suggestion.field.cell) && looksDataLikeLabel(suggestion.sourceLabel))
    || name === 'no'
    || name === 'yes'
    || name === 'ok'
    || name === 'nq'
    || /^n[qd]_\d/.test(name)
    || /e_\d+$/.test(name);
}

function uniqueSuggestionName(): (suggestion: SchemaSuggestion) => boolean {
  const seenFieldNames = new Set<string>();
  return (suggestion: SchemaSuggestion) => {
    if (suggestion.kind === 'field') {
      const name = suggestion.field.name.trim().toLowerCase();
      if (seenFieldNames.has(name)) return false;
      seenFieldNames.add(name);
    }
    return true;
  };
}

function isPlaceholderValue(value: CellValue | undefined): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'string') return false;
  const trimmed = value.trim().toLowerCase();
  return trimmed === 'n/a' || trimmed === 'na' || trimmed === 'none' || trimmed === 'null' || trimmed === '-';
}

/** A table needs real column names: a header row of placeholders names nothing. */
function hasInformativeHeaders(headers: string[]): boolean {
  const informative = headers.filter((header) => !isPlaceholderValue(header)).length;
  return informative >= Math.max(2, Math.ceil(headers.length * 0.6));
}

function looksDataLikeLabel(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^[0-9]/.test(trimmed)) return true;
  if (/^(nq|nd|lod)[<>]/i.test(trimmed)) return true;
  if (!/\s/.test(trimmed) && looksIdentifierLike(trimmed)) return true;
  return !/\s/.test(trimmed) && /[0-9._-]/.test(trimmed) && /^[A-Z0-9._-]{7,}$/i.test(trimmed);
}

function isLikelyLabel(value: string | null | undefined): value is string {
  if (!value) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.length > 48) return false;
  if (/[<>=%]/.test(trimmed)) return false;
  if (/\d(?:\.\d+)?e[+-]?\d+/i.test(trimmed)) return false;
  if (/^\d+([./-]\d+)*$/.test(trimmed)) return false;
  if (trimmed.split(/\s+/).length > 6) return false;
  return /[a-z]/i.test(trimmed);
}

function isNestedFieldInsideStrongTable(suggestion: SchemaSuggestion, all: SchemaSuggestion[]): boolean {
  if (suggestion.kind !== 'field') return false;
  const fieldRef = parseSuggestionRef(suggestion);
  if (!fieldRef) return false;

  return all.some((candidate) => {
    if (candidate.kind !== 'table' || candidate.score < 0.75) return false;
    const tableRef = parseSuggestionRef(candidate);
    if (!tableRef) return false;
    if (fieldRef.sheetName !== tableRef.sheetName) return false;
    const rowInside = fieldRef.startRow >= tableRef.startRow && fieldRef.endRow <= tableRef.endRow;
    const fullyInside =
      fieldRef.startCol >= tableRef.startCol
      && fieldRef.endCol <= tableRef.endCol
      && rowInside;
    const adjacentAcrossSpacer =
      rowInside
      && (
        (fieldRef.startCol > tableRef.endCol && fieldRef.startCol - tableRef.endCol <= 4)
        || (tableRef.startCol > fieldRef.endCol && tableRef.startCol - fieldRef.endCol <= 4)
      );
    return fullyInside || adjacentAcrossSpacer;
  });
}

function looksEmphasized(style: CellInfo['style'] | undefined): boolean {
  return Boolean(style?.bold || style?.bgColor || style?.borderBottom || style?.borderTop);
}

function hasValue(value: CellValue | undefined): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

/**
 * True when the cell holds its own value. A merged region reports its value in every
 * cell it covers, and those continuations are not extra columns of data.
 */
function hasOwnValue(
  sheetData: ReturnType<typeof getSheetData>,
  row: number,
  col: number,
): boolean {
  if (!hasValue(sheetData.data[row]?.[col])) return false;
  const merge = sheetData.cells[row]?.[col]?.merge;
  if (!merge) return true;
  return merge.left === col && merge.top === row;
}

function stringifyValue(value: CellValue | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return String(value).trim();
}

function asString(value: CellValue | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function columnLetter(index: number): string {
  let result = '';
  let current = index;
  while (current >= 0) {
    result = String.fromCharCode((current % 26) + 65) + result;
    current = Math.floor(current / 26) - 1;
  }
  return result;
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(0.99, Number(score.toFixed(2))));
}
