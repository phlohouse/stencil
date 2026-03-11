# Schema Reference

A `.stencil.yaml` file describes how to extract structured data from one category of spreadsheet (e.g. "lab report", "invoice"). This page is the complete reference for the schema format.

## Top-Level Structure

```yaml
name: lab_report                    # Required. Identifier for this schema.
description: Monthly lab report     # Optional. Human-readable description.

discriminator:                      # Required. How to detect which version applies.
  cells:
    - A1

versions:                           # Required. At least one version.
  "v2.0":
    fields: { ... }
    validation: { ... }             # Optional.
  "v1.0":
    fields: { ... }
```

### Fields

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `name` | `string` | Yes | Unique identifier for this schema. Used in model class names and caching. |
| `description` | `string` | No | Human-readable description. Defaults to `""`. |
| `discriminator` | `object` | Yes | Contains a `cells` list (or legacy `cell` string) identifying which cells to check for version detection. |
| `versions` | `object` | Yes | Map of version keys to version definitions. At least one required. |

---

## Discriminator

The discriminator tells stencilpy which cell(s) to read in order to determine which version of the schema applies to a given Excel file.

```yaml
discriminator:
  cells:
    - A1              # Check A1 first
    - Sheet2!B1       # Then check B1 on Sheet2
```

Discriminator entries can also point at worksheet headers and footers:

```yaml
discriminator:
  cells:
    - A1
    - header:right
    - Cover!footer:first:center
```

- Cell values are cast to strings and stripped of whitespace.
- The value is matched against the version keys (e.g., `"v2.0"`, `"v1.0"`).
- Cells are checked in order — the first match wins.
- If no discriminator cell matches, stencilpy falls back to [layout inference](version-detection.md).
- If neither discriminator nor inference succeeds, a `VersionError` is raised.

### Legacy Format

The legacy single-cell format is still supported:

```yaml
discriminator:
  cell: A1    # Equivalent to cells: [A1]
```

---

## Versions

Each version defines a set of fields to extract and optional validation rules.

```yaml
versions:
  "v2.0":
    fields:
      patient_name:
        cell: B3
      readings:
        range: D5:D
        type: list[float]
    validation:
      readings:
        min: 0
        max: 1000
```

### Version Inheritance (`extends`)

A version can inherit fields from another version using `extends`:

```yaml
versions:
  "v1.0":
    fields:
      patient_name:
        cell: A3
      readings:
        range: C2:C
        type: list[float]

  "v2.0":
    extends: "v1.0"           # Inherits all fields from v1.0
    fields:
      email:                  # New field added in v2.0
        cell: D3
      patient_name:           # Overrides v1.0's patient_name
        cell: B3
```

Rules:

- Child fields override parent fields of the same name.
- Parent fields not overridden are included as-is, including their validation.
- Chains are supported: `v3.0` can extend `v2.0` which extends `v1.0`.
- Circular extends are detected and raise a `StencilError`.

---

## Fields

Each field maps a name to a location in the spreadsheet.

### Cell Fields

Extract a single value from one cell:

```yaml
patient_name:
  cell: B3

sample_date:
  cell: B4
  type: datetime
```

Header and footer text can also be read through `cell` fields:

```yaml
report_version:
  cell: header:right

report_title:
  cell: header:center

footer_note:
  cell: footer:center

cover_version:
  cell: Cover!header:first:right
```

This is useful when report metadata or version strings are printed in the page chrome instead of normal worksheet cells.

### Range Fields

Extract a contiguous range of cells:

```yaml
readings:
  range: D5:D50         # Bounded range
  type: list[float]

readings:
  range: D5:D           # Open-ended: reads until first empty row
  type: list[float]
```

### Computed Fields

Derived from other fields (see [Computed Fields](computed-fields.md)):

```yaml
full_name:
  computed: "{first_name} {last_name}"

bmi:
  computed: "{weight} / ({height} ** 2)"
```

---

## Field Types

Type is **optional**. Defaults are:
- Single cell → `str`
- Range → `list[str]`
- Computed → `any`

| Type | Description | Python Type |
|------|-------------|-------------|
| `str` | String (default for cells) | `str` |
| `int` | Integer | `int` |
| `float` | Floating-point number | `float` |
| `bool` | Boolean | `bool` |
| `datetime` | Date and time | `datetime.datetime` |
| `date` | Date only | `datetime.date` |
| `list[str]` | List of strings (default for ranges) | `list[str]` |
| `list[int]` | List of integers | `list[int]` |
| `list[float]` | List of floats | `list[float]` |
| `list[bool]` | List of booleans | `list[bool]` |
| `dict[str, str]` | Key-value pairs from a 2-column range | `dict[str, str]` |
| `table` | Table from a 2D range → list of row dicts | `list[dict[str, Any]]` |
| `any` | No type coercion (used for computed fields) | `Any` |

---

## Cell & Range Addressing

| Format | Example | Description |
|--------|---------|-------------|
| Single cell | `A1`, `B3`, `AA12` | One cell |
| Bounded range | `A1:D50` | Fixed rectangle |
| Open-ended range | `D5:D` | Column D from row 5 to the last non-empty row |
| Sheet-qualified cell | `Sheet2!A1` | Cell on a specific sheet |
| Sheet-qualified range | `Sheet2!A1:D50` | Range on a specific sheet |
| Header ref | `header:right` | Right section of the odd-page header on the first sheet |
| Footer ref | `footer:center` | Center section of the odd-page footer on the first sheet |
| Page-qualified header/footer ref | `header:first:left`, `footer:even:right` | Header/footer section for first or even pages |
| Sheet-qualified header/footer ref | `Cover!header:right` | Header/footer section on a specific sheet |

- If no sheet is specified, the **first sheet** in the workbook is used.
- Open-ended ranges stop at the first **fully empty row** (all cells in the row are empty).
- Header/footer refs default to the worksheet's `odd` header/footer when no page selector is provided.

### Header And Footer Reference Syntax

Supported scalar reference forms:

- `header:left`
- `header:center`
- `header:right`
- `footer:left`
- `footer:center`
- `footer:right`
- `header:first:left`
- `header:even:center`
- `footer:first:right`
- `Sheet1!header:right`
- `Sheet1!footer:even:left`

---

## Tables

Tables extract a 2D range into a list of dictionaries.

### Auto-detected Headers

By default, the first row of the range is treated as column headers:

```yaml
results_table:
  range: A20:D
  type: table
```

If `A20:D22` contains:

| A | B | C | D |
|---|---|---|---|
| analyte | value | unit | flag |
| Glucose | 95 | mg/dL | normal |
| Cholesterol | 180 | mg/dL | high |

Result:
```python
[
    {"analyte": "Glucose", "value": 95, "unit": "mg/dL", "flag": "normal"},
    {"analyte": "Cholesterol", "value": 180, "unit": "mg/dL", "flag": "high"},
]
```

### Explicit Column Mapping

Use `columns` to map column letters to field names. When explicit columns are provided, **no header row is consumed** — all rows are treated as data:

```yaml
results_table:
  range: A1:D
  type: table
  columns:
    A: analyte
    B: value
    C: unit
    D: flag
```

### Vertical Tables

Tables where headers run down the left column and data runs across columns:

```yaml
patient_info:
  range: A1:C3
  type: table
  orientation: vertical
```

---

## Dict Fields

Extract a 2-column range as key-value pairs:

```yaml
metadata:
  range: A10:B15
  type: dict[str, str]
```

If the range contains:

| A | B |
|---|---|
| lab_id | LAB-001 |
| technician | Dr. Smith |
| method | HPLC |

Result:
```python
{"lab_id": "LAB-001", "technician": "Dr. Smith", "method": "HPLC"}
```

---

## Validation

Per-field validation rules are **optional** — only applied when explicitly declared. Defined under a `validation` key at the version level:

```yaml
versions:
  "v2.0":
    fields:
      readings:
        range: D5:D
        type: list[float]
      patient_name:
        cell: B3
    validation:
      readings:
        min: 0
        max: 1000
      patient_name:
        pattern: "^[A-Za-z ]+$"
```

### Validation Rules

| Rule | Applies To | Description |
|------|-----------|-------------|
| `min` | Numeric fields | Minimum allowed value (inclusive). Maps to Pydantic's `ge`. |
| `max` | Numeric fields | Maximum allowed value (inclusive). Maps to Pydantic's `le`. |
| `pattern` | String fields | Regex pattern the value must match. Maps to Pydantic's `pattern`. |
| `required` | All fields | Whether the field must be non-empty. Default: `true`. When `true` and validation is declared, the Pydantic model will not accept `None` for that field. |

Validation constraints are applied at the Pydantic model level — if validation fails, a `ValidationError` is raised during extraction.

---

## Multi-Sheet Extraction

Fields can reference any sheet using `Sheet!Cell` notation. A single schema can pull data from multiple sheets within the same workbook:

```yaml
versions:
  "v1.0":
    fields:
      patient_name:
        cell: A3
      results_table:
        range: Sheet2!A1:D
        type: table
```

---

## Complete Example

```yaml
name: lab_report
description: Monthly lab report from ACME Labs

discriminator:
  cells:
    - A1

versions:
  "v1.0":
    fields:
      patient_name:
        cell: A3
      readings:
        range: C2:C
        type: list[float]
      results_table:
        range: Sheet2!A1:D
        type: table
        columns:
          A: analyte
          B: value
          C: unit
          D: flag

  "v2.0":
    extends: "v1.0"
    fields:
      patient_name:
        cell: B3
      sample_date:
        cell: B4
        type: datetime
      metadata:
        range: A10:B15
        type: dict[str, str]
      weight:
        cell: E3
        type: float
      height:
        cell: E4
        type: float
      bmi:
        computed: "{weight} / ({height} ** 2)"
      readings:
        range: D5:D
        type: list[float]
      results_table:
        range: A20:D
        type: table
    validation:
      readings:
        min: 0
        max: 1000
      patient_name:
        pattern: "^[A-Za-z ]+$"
```
