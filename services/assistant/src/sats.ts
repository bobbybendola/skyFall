// SpacetimeDB SQL returns SATS-JSON: rows are arrays, options are [index, payload],
// and timestamps are a one-field product of microseconds. See the HTTP SQL docs.

export type AlgType = {
  String?: unknown;
  Bool?: unknown;
  F32?: unknown;
  F64?: unknown;
  I8?: unknown;
  I16?: unknown;
  I32?: unknown;
  I64?: unknown;
  U8?: unknown;
  U16?: unknown;
  U32?: unknown;
  U64?: unknown;
  Sum?: { variants: Variant[] };
  Product?: { elements: Field[] };
};

type Field = { name: { some?: string } | null; algebraic_type: AlgType };
type Variant = { name: { some?: string } | null; algebraic_type: AlgType };

const PRIMITIVES = [
  'String',
  'Bool',
  'F32',
  'F64',
  'I8',
  'I16',
  'I32',
  'I64',
  'U8',
  'U16',
  'U32',
  'U64',
] as const;

export type SqlStatement = {
  schema: { elements: Field[] };
  rows: unknown[][];
};

export type TableRow = Record<string, unknown>;

function fieldName(name: { some?: string } | null | undefined, index: number): string {
  return name?.some ?? `col_${index}`;
}

export function decodeValue(type: AlgType, value: unknown): unknown {
  if (type.Sum) {
    if (!Array.isArray(value) || value.length < 2) return null;
    const index = value[0];
    if (typeof index !== 'number') return null;
    const variant = type.Sum.variants[index];
    if (!variant) return null;
    if (variant.name?.some === 'none') return null;
    return decodeValue(variant.algebraic_type, value[1]);
  }
  if (type.Product) {
    const elements = type.Product.elements;
    if (
      elements.length === 1 &&
      elements[0]?.name?.some === '__timestamp_micros_since_unix_epoch__'
    ) {
      const micros = Array.isArray(value) ? value[0] : value;
      if (typeof micros !== 'number' || !Number.isFinite(micros)) return null;
      return new Date(micros / 1000).toISOString();
    }
    if (!Array.isArray(value)) return null;
    const out: TableRow = {};
    elements.forEach((el, i) => {
      out[fieldName(el.name, i)] = decodeValue(el.algebraic_type, value[i]);
    });
    return out;
  }
  if (PRIMITIVES.some(key => key in type)) return value;
  return value;
}

export function decodeRows(statement: SqlStatement): TableRow[] {
  return statement.rows.map(row => {
    const out: TableRow = {};
    statement.schema.elements.forEach((el, i) => {
      out[fieldName(el.name, i)] = decodeValue(el.algebraic_type, row[i]);
    });
    return out;
  });
}
