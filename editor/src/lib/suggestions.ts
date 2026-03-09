import { formatRange, formatSheetRef, parseAddress } from './addressing';
import { slugify } from './field-naming';
import { getSheetData, getSheetNames, type CellInfo, type CellValue, type Workbook } from './excel';
import type { StencilField } from './types';

export type SchemaSuggestion =
  | FieldSuggestion
  | TableSuggestion
  | DiscriminatorSuggestion;

interface SuggestionBase {
  id: string;
  kind: 'field' | 'table' | 'discriminator';
  sheetName: string;
  score: number;
  reasons: string[];
  bounds?: ParsedRef;
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

const VERSION_LABEL_RE = /\b(version|template|form|revision|rev)\b/i;
const MAX_FIELD_SUGGESTIONS = 14;
const MAX_TABLE_SUGGESTIONS = 14;

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
  const existingRefs = collectExistingRefs(defaultSheet, context.existingFields);
  const existingNames = new Set((context.existingFields ?? []).map((field) => field.name));
  const existingDiscriminators = new Set(context.existingDiscriminatorCells ?? []);

  for (const sheetName of sheetNames) {
    const sheetData = getSheetData(workbook, sheetName);
    suggestions.push(
      ...findFieldSuggestions(sheetData, defaultSheet, existingRefs, existingNames),
      ...findRangeSuggestions(sheetData, defaultSheet, existingRefs, existingNames),
      ...findTableSuggestions(sheetData, defaultSheet, existingRefs, existingNames),
      ...findTitledTableSuggestions(sheetData, defaultSheet, existingRefs, existingNames),
      ...findDiscriminatorSuggestions(sheetData, defaultSheet, existingDiscriminators),
    );
  }

  return suppressOverlaps(dedupeSuggestions(suggestions))
    .filter((suggestion, _index, all) => !isNestedFieldInsideStrongTable(suggestion, all))
    .filter((suggestion) => !shouldDropSuggestion(suggestion))
    .filter(uniqueSuggestionName())
    .sort(compareSuggestions)
    .slice(0, 24);
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

  for (let row = 0; row < Math.max(0, sheetData.rows - 3); row++) {
    for (let col = 0; col < sheetData.cols; col++) {
      const label = asString(sheetData.data[row]?.[col]);
      if (!isLikelyLabel(label)) continue;

      const name = slugify(cleanLabel(label));
      if (!name || existingNames.has(name)) continue;
      const headerBand = detectHeaderBand(sheetData, row, col);

      const verticalDepth = measureLinearDepth(sheetData, row + 1, col, 'vertical');
      if (verticalDepth >= 3) {
        const startOffset = findLeadingPlaceholderOffset(
          collectLinearValues(sheetData, row + 1, col, 'vertical', verticalDepth),
        );
        const effectiveDepth = verticalDepth - startOffset;
        if (effectiveDepth < 3) continue;
        const values = collectLinearValues(sheetData, row + 1 + startOffset, col, 'vertical', effectiveDepth);
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

      const horizontalDepth = measureLinearDepth(sheetData, row, col + 1, 'horizontal');
      if (horizontalDepth >= 3) {
        const startOffset = findLeadingPlaceholderOffset(
          collectLinearValues(sheetData, row, col + 1, 'horizontal', horizontalDepth),
        );
        const effectiveDepth = horizontalDepth - startOffset;
        if (effectiveDepth < 3) continue;
        const values = collectLinearValues(sheetData, row, col + 1 + startOffset, 'horizontal', effectiveDepth);
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
      if (headers.some((header) => slugify(header).length < 2)) continue;
      const headerLikeCount = headers.filter(isLikelyHeaderCell).length;
      const dataLikeHeaderCount = headers.filter((header) => looksDataLikeLabel(header) || looksStatusLike(header)).length;
      const informativeHeaderCount = headerLikeCount + dataLikeHeaderCount;
      if (headers.length >= 4 && headerLikeCount < Math.max(2, Math.ceil(headers.length * 0.3))) continue;
      if (headers.length >= 4 && informativeHeaderCount < Math.ceil(headers.length * 0.75)) continue;
      if (dataLikeHeaderCount > Math.floor(headers.length * 0.65)) continue;

      const depth = measureTableDepth(sheetData, row + 1, run.start, run.end);
      const sampleRowValues = collectRowValues(sheetData, row + 1, run.start, run.end);
      const identifierLikeCells = sampleRowValues.filter((value) => looksIdentifierLike(stringifyValue(value))).length;
      const width = run.end - run.start + 1;
      const typedSampleCells = sampleRowValues.filter((value) => (
        looksIdentifierLike(stringifyValue(value))
        || inferFieldType(value) !== 'str'
        || looksStatusLike(stringifyValue(value))
      )).length;
      const shallowStructuredRow = depth === 1
        && sampleRowValues.filter(hasValue).length >= Math.max(2, Math.ceil(run.length * 0.5))
        && typedSampleCells >= Math.max(2, Math.ceil(width * 0.35));
      if (depth < 2 && !shallowStructuredRow) continue;

      let score = 0.62;
      const reasons = ['contiguous header row with repeated data underneath'];

      if (depth >= 3) {
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
      if (depth >= 4) {
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
          endRow: row + depth,
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
          columns: Object.fromEntries(
            rawHeaders
              .map((header, index) => ({ header, index }))
              .filter((entry) => Boolean(entry.header))
              .map((entry) => [columnLetter(run.start + entry.index), slugify(entry.header) || `column_${entry.index + 1}`]),
          ),
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
  const maxRows = Math.min(sheetData.rows, 12);
  const maxCols = Math.min(sheetData.cols, 6);

  for (let row = 0; row < maxRows; row++) {
    for (let col = 0; col < maxCols; col++) {
      const label = asString(sheetData.data[row]?.[col]);
      if (!label || !VERSION_LABEL_RE.test(label)) continue;

      const value = sheetData.data[row]?.[col + 1] ?? sheetData.data[row + 1]?.[col];
      const valueRef = sheetData.data[row]?.[col + 1] != null
        ? { row, col: col + 1 }
        : { row: row + 1, col };
      if (!hasValue(value) || valueRef.row >= sheetData.rows || valueRef.col >= sheetData.cols) continue;

      const valueString = stringifyValue(value);
      if (!valueString) continue;

      let score = 0.65;
      const reasons = ['keyword label suggests a version or revision field'];
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

      const titledRuns: Array<{ row: number; start: number; end: number; values: string[]; depth: number; distance: number }> = [];
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
          const headerLikeCount = headers.filter(isLikelyHeaderCell).length;
          const dataLikeHeaderCount = headers.filter((header) => looksDataLikeLabel(header) || looksStatusLike(header)).length;
          const informativeHeaderCount = headerLikeCount + dataLikeHeaderCount;
          if (headers.length >= 4 && headerLikeCount < Math.max(2, Math.ceil(headers.length * 0.3))) continue;
          if (headers.length >= 4 && informativeHeaderCount < Math.ceil(headers.length * 0.75)) continue;
          if (dataLikeHeaderCount > Math.floor(headers.length * 0.65)) continue;
          const depth = measureTableDepth(sheetData, headerRow + 1, run.start, run.end);
          const sampleRowValues = collectRowValues(sheetData, headerRow + 1, run.start, run.end);
          const typedSampleCells = sampleRowValues.filter((value) => (
            looksIdentifierLike(stringifyValue(value))
            || inferFieldType(value) !== 'str'
            || looksStatusLike(stringifyValue(value))
          )).length;
          const shallowStructuredRow = depth === 1
            && sampleRowValues.filter(hasValue).length >= Math.max(2, Math.ceil(run.length * 0.35))
            && typedSampleCells >= Math.max(2, Math.ceil(run.length * 0.25));
          if (depth < 2 && !shallowStructuredRow) continue;
          titledRuns.push({ row: headerRow, start: run.start, end: run.end, values: run.values, depth, distance });
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
        if (run.depth >= 3) {
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
            endRow: run.row + run.depth,
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
            columns: Object.fromEntries(
              disambiguateHeaders(headers).map((header, headerIndex) => [columnLetter(run.start + headerIndex), header]),
            ),
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
  let depth = 0;
  const width = endCol - startCol + 1;
  const threshold = Math.max(1, Math.ceil(width * 0.4));

  for (let row = startRow; row < sheetData.rows; row++) {
    let populated = 0;
    for (let col = startCol; col <= endCol; col++) {
      if (hasValue(sheetData.data[row]?.[col])) {
        populated += 1;
      }
    }
    if (populated < threshold) break;
    depth += 1;
  }

  return depth;
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

function detectHeaderBand(
  sheetData: ReturnType<typeof getSheetData>,
  row: number,
  col: number,
): HeaderBand | null {
  const runs = findNonEmptyRuns(sheetData.data[row] ?? [], sheetData.hiddenCols);
  const run = runs.find((candidate) => col >= candidate.start && col <= candidate.end);
  if (!run || run.length < 4) return null;

  return {
    startCol: run.start,
    endCol: run.end,
    width: run.length,
    depth: measureTableDepth(sheetData, row + 1, run.start, run.end),
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
    for (let col = Math.max(0, startCol - 2); col <= Math.min(sheetData.cols - 1, endCol); col++) {
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

function collectExistingRefs(defaultSheet: string, fields: StencilField[] | undefined): ParsedRef[] {
  return (fields ?? [])
    .map((field) => parseStencilRef(field.cell ?? field.range, defaultSheet))
    .filter((entry): entry is ParsedRef => entry !== null);
}

function refOverlapsExisting(ref: string, defaultSheet: string, existingRefs: ParsedRef[]): boolean {
  const parsed = parseStencilRef(ref, defaultSheet);
  if (!parsed) return false;
  return existingRefs.some((existing) => refsOverlap(existing, parsed));
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

function looksDataLikeLabel(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^[0-9]/.test(trimmed)) return true;
  if (/^(nq|nd|lod)[<>]/i.test(trimmed)) return true;
  if (!/\s/.test(trimmed) && looksIdentifierLike(trimmed)) return true;
  return !/\s/.test(trimmed) && /^[A-Z0-9._-]{7,}$/i.test(trimmed);
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
