export interface StencilField {
  name: string;
  cell?: string;
  range?: string;
  type?: string;
  tableOrientation?: 'horizontal' | 'vertical';
  computed?: string;
  columns?: Record<string, string>;
  openEnded?: boolean;
  /** Consecutive blank rows that end an open-ended range (default 1). */
  blankRows?: number;
}

export interface StencilValidation {
  min?: number;
  max?: number;
  pattern?: string;
  required?: boolean;
}

export interface StencilVersion {
  id?: string;
  discriminatorValue: string;
  fields: StencilField[];
  validation: Record<string, StencilValidation>;
}

export interface StencilSchema {
  name: string;
  description: string;
  discriminator: { cell: string; cells?: string[] };
  versions: StencilVersion[];
}

export interface CellAddress {
  col: number;
  row: number;
}

export interface CellRange {
  start: CellAddress;
  end: CellAddress;
  openEnded?: boolean;
}

export interface Selection {
  start: CellAddress;
  end: CellAddress;
}

/**
 * What a mouse gesture on the grid turned out to be once the pointer was
 * released. The view resolves the gesture and hands the final selection to the
 * app, so nothing downstream has to read (possibly stale) selection state.
 */
export type GestureKind =
  | 'select'
  | 'select-field'
  | 'select-suggestion'
  | 'move-field'
  | 'resize-field'
  | 'resize-suggestion';

export interface GestureResult {
  kind: GestureKind;
  selection: Selection;
  fieldName?: string;
  suggestionId?: string;
  /** The region the gesture started from (resolved for open-ended ranges). */
  sourceRange?: Selection;
  /** For `move-field`: whether the region actually ended up somewhere new. */
  moved?: boolean;
}

export type HeaderFooterKind = 'header' | 'footer';
export type HeaderFooterPage = 'odd' | 'first' | 'even';
export type HeaderFooterSection = 'left' | 'center' | 'right';

export type FieldType =
  | 'str'
  | 'int'
  | 'float'
  | 'bool'
  | 'datetime'
  | 'date'
  | 'list[str]'
  | 'list[int]'
  | 'list[float]'
  | 'list[bool]'
  | 'dict'
  | 'dict[str, str]'
  | 'dict[str, int]'
  | 'dict[str, float]'
  | 'table';

export const FIELD_TYPES: FieldType[] = [
  'str',
  'int',
  'float',
  'bool',
  'datetime',
  'date',
  'list[str]',
  'list[int]',
  'list[float]',
  'list[bool]',
  'dict',
  'dict[str, str]',
  'dict[str, int]',
  'dict[str, float]',
  'table',
];
