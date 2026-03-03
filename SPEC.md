# Stencil

> Lay a template over a spreadsheet. Extract structured data.

## Overview

Stencil is a two-part system for extracting structured data from Excel files:

1. **Stencil Editor** — a web app for visually mapping cells/ranges in a spreadsheet to named fields, outputting a YAML schema.
2. **Stencil (Python library)** — reads a YAML schema + Excel file, auto-selects the correct version, and returns a dynamically-generated Pydantic model.

---

## YAML Schema Spec

A `.stencil.yaml` file describes how to extract data from one category of spreadsheet (e.g., "lab report", "invoice").

```yaml
name: lab_report
description: Monthly lab report from ACME Labs

discriminator:
  cell: A1

versions:
  "v2.0":
    fields:
      # type is optional — defaults to str for cells, list[str] for ranges
      patient_name:
        cell: B3

      sample_date:
        cell: B4
        type: datetime

      readings:
        range: D5:D
        type: list[float]

      # table: headers from first row by default, or explicit column mapping
      results_table:
        range: A20:D
        type: table
        columns:
          A: analyte
          B: value
          C: unit
          D: flag

      metadata:
        range: A10:B15
        type: dict[str, str]

      # computed/derived fields
      full_name:
        computed: "{first_name} {last_name}"

      bmi:
        computed: "{weight} / ({height} ** 2)"

    # optional field-level validation
    validation:
      readings:
        min: 0
        max: 1000
      patient_name:
        pattern: "^[A-Za-z ]+$"

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
```

### Field Types

Type is **optional**. Defaults to `str` for single cells, `list[str]` for 1D ranges.

| Type              | Description                                      |
|-------------------|--------------------------------------------------|
| `str`             | Single cell → string (default for cells)         |
| `int`             | Single cell → integer                            |
| `float`           | Single cell → float                              |
| `bool`            | Single cell → boolean                            |
| `datetime`        | Single cell → datetime                           |
| `date`            | Single cell → date                               |
| `list[T]`         | Contiguous range (1D) → list of T                |
| `dict[str, str]`  | Contiguous range (2 cols) → key-value pairs      |
| `table`           | Contiguous range (2D) → list of dicts            |
| `computed`        | Derived from other fields (see below)            |

### Cell/Range Addressing

- Single cell: `A1`, `B3`, `AA12`
- Range (bounded): `A1:A50`, `A1:D1`, `A1:D50`
- Range (open-ended): `D5:D` — from D5 to last non-empty row in column D
- Sheet-qualified: `Sheet2!A1`, `Sheet2!A1:D50`, `Sheet2!A1:D`
- Default sheet: first sheet if unspecified

### Tables

- Default: first row of range is treated as headers
- Explicit `columns` mapping overrides header detection — keys are column letters, values are field names
- Open-ended ranges (`A1:D`) read until the first fully empty row

### Computed Fields

- Reference other fields with `{field_name}` syntax
- Supports Python expressions: `"{weight} / ({height} ** 2)"`
- Computed fields are evaluated after all other fields are extracted
- Dependency order is resolved automatically

### Validation (Optional)

Per-field validation rules, applied during Pydantic model generation:

| Rule      | Description                          |
|-----------|--------------------------------------|
| `min`     | Minimum value (numeric)              |
| `max`     | Maximum value (numeric)              |
| `pattern` | Regex pattern (strings)              |
| `required`| Whether field must be non-empty (default: true) |

Validation is **off by default** — only applied when explicitly declared.

### Discriminator

- `cell` — the cell to read
- The value in that cell is matched against the keys under `versions`
- If no match is found, raise `VersionError`
- Discriminator matching is string-based (cell value is cast to str and stripped)

### Multi-Sheet Extraction

Fields can reference any sheet via `Sheet2!A1` notation. A single schema can pull data from multiple sheets within the same workbook.

---

## Python Library (`stencilpy`)

### Installation

```bash
pip install stencilpy
```

### Basic Usage

```python
from stencilpy import Stencil

# Load a schema — version is auto-detected on extract
lab = Stencil("lab_report.stencil.yaml")

report = lab.extract("january_lab.xlsx")

# report is a Pydantic model instance
print(report.patient_name)    # "Jane Doe"
print(report.readings)        # [1.2, 3.4, 5.6, ...]
print(report.sample_date)     # datetime(2026, 1, 15)
print(report.model_dump())    # {"patient_name": "Jane Doe", ...}
```

### Loading a Directory of Schemas

```python
from stencilpy import Stencil

# Load all .stencil.yaml files — auto-detect which schema matches
lab = Stencil.from_dir("./schemas/")

report = lab.extract("mystery_file.xlsx")
```

### Batch Processing

```python
from pathlib import Path

results = lab.extract_batch(Path("./uploads").glob("*.xlsx"))
# results: list[tuple[Path, Model | StencilError]]
```

### Error Handling

```python
from stencilpy import StencilError, VersionError, ValidationError

try:
    report = lab.extract("bad_file.xlsx")
except VersionError:
    # Discriminator value didn't match any version
except ValidationError:
    # Data didn't pass Pydantic validation
except StencilError:
    # Base error class
```

### Inspecting Generated Models

```python
# Access the generated Pydantic model classes
lab.models
# {"v2.0": <class 'LabReport_v2_0'>, "v1.0": <class 'LabReport_v1_0'>}

# Get JSON Schema for a version
lab.models["v2.0"].model_json_schema()
```

---

## Stencil Editor (Web App)

### Core Workflow

1. Upload / open an Excel file
2. Spreadsheet renders in browser (read-only)
3. Click a cell or drag to select a range
4. A panel appears: name the field, set the type
5. Repeat for all fields
6. Set the discriminator cell
7. Export as `.stencil.yaml`

### Nice-to-haves (later)

- Import existing `.stencil.yaml` to edit/update
- Side-by-side view of two versions of a spreadsheet
- Preview extracted data against the current schema
- Validate schema against multiple sample files

---

## Resolved Decisions

- [x] Tables support explicit column mapping with first-row headers as default
- [x] Computed/derived fields supported via `{field_name}` interpolation + Python expressions
- [x] Open-ended ranges supported (`D5:D` reads to last non-empty row)
- [x] Multi-sheet extraction via `Sheet2!A1` notation
- [x] Field-level validation supported but off by default
- [x] Package name: `stencilpy`
- [x] Type is optional in YAML — defaults to `str` (cells) / `list[str]` (ranges)
- [x] Class-based Python API — `Stencil` object holds schema, `.extract()` returns models
- [x] Computed fields: trust the YAML author, no sandboxing
- [x] `from_dir` tries all schemas (brute-force match on discriminator)
- [x] Editor: standalone web app, React + SheetJS
- [x] Editor is standalone, not embeddable

## Open Questions

_(none — ready to build)_
