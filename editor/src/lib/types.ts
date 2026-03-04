export interface StencilField {
  name: string;
  cell?: string;
  range?: string;
  type?: string;
  tableOrientation?: 'horizontal' | 'vertical';
  computed?: string;
  columns?: Record<string, string>;
  openEnded?: boolean;
}

export interface StencilValidation {
  min?: number;
  max?: number;
  pattern?: string;
  required?: boolean;
}

export interface StencilVersion {
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
