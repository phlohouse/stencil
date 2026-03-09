# Stencil

> Lay a template over a spreadsheet. Extract structured data.

Stencil is a two-part system for extracting structured data from Excel files:

1. **Stencil Editor** — a desktop/web app for visually mapping cells and ranges in a spreadsheet to named fields, exporting `.stencil.yaml` schema files.
2. **stencilpy** — a Python library that reads a YAML schema + Excel file, auto-detects the version, and returns a dynamically-generated Pydantic model.

## Quick Start

### 1. Define a schema

Use the editor (`make dev` or `make build-app` for the desktop app), or write YAML by hand:

```yaml
name: lab_report
description: Monthly lab report from ACME Labs

discriminator:
  cells:
    - A1

versions:
  "v2.0":
    fields:
      patient_name:
        cell: B3

      sample_date:
        cell: B4
        type: datetime

      readings:
        range: D5:D
        type: list[float]

      results_table:
        range: A20:D
        type: table
        columns:
          A: analyte
          B: value
          C: unit
          D: flag
```

### 2. Extract data

```bash
pip install stencilpy
```

```python
from stencilpy import Stencil

lab = Stencil("lab_report.stencil.yaml")
report = lab.extract("january_lab.xlsx")

print(report.patient_name)        # "Jane Doe"
print(report.sample_date)         # datetime(2026, 1, 15)
print(report.readings[:3])        # [1.2, 3.4, 5.6]
print(report.results_table[0])    # {"analyte": "HIV-1", "value": "Pos", ...}

# Full Pydantic model — serialize, validate, export
print(report.model_dump())
```

## Python Library Usage

### Loading a schema

```python
from stencilpy import Stencil

# From a single file
lab = Stencil("lab_report.stencil.yaml")

# From a directory of schemas — auto-matches by discriminator
lab = Stencil.from_dir("./schemas/")
```

### Extracting data

```python
# Version is auto-detected from the discriminator cell
report = lab.extract("january_lab.xlsx")

# The result is a Pydantic BaseModel instance
print(type(report))               # <class 'LabReport_v2_0'>
print(report.patient_name)        # field access
print(report.model_dump())        # dict
print(report.model_dump_json())   # JSON string
```

### Batch processing

```python
from pathlib import Path

results = lab.extract_batch(Path("./uploads").glob("*.xlsx"))

for path, result in results:
    if isinstance(result, Exception):
        print(f"FAILED {path}: {result}")
    else:
        print(f"OK {path}: {result.patient_name}")
```

### Inspecting generated models

```python
# See all version models
lab.models
# {"v2.0": <class 'LabReport_v2_0'>, "v1.0": <class 'LabReport_v1_0'>}

# Get JSON Schema for integration with other tools
lab.models["v2.0"].model_json_schema()
```

### Error handling

```python
from stencilpy import Stencil, VersionError, ValidationError, StencilError

lab = Stencil("schema.stencil.yaml")

try:
    report = lab.extract("file.xlsx")
except VersionError:
    # Discriminator cell value didn't match any version
    pass
except ValidationError:
    # Extracted data didn't pass Pydantic validation
    pass
except StencilError:
    # Base class for all stencil errors
    pass
```

## YAML Schema Reference

### Field types

Type is **optional** — defaults to `str` for single cells, `list[str]` for ranges.

| Type | Description |
|------|-------------|
| `str` | Single cell → string (default) |
| `int` | Single cell → integer |
| `float` | Single cell → float |
| `bool` | Single cell → boolean |
| `datetime` | Single cell → datetime |
| `date` | Single cell → date |
| `list[T]` | 1D range → list of T |
| `dict[str, str]` | 2-column range → key-value pairs |
| `table` | 2D range → list of dicts |

### Cell addressing

```yaml
# Single cell
cell: B3

# Bounded range
range: A1:D50

# Open-ended range (reads until first empty row)
range: D5:D

# Sheet-qualified
range: Sheet2!A1:D
```

### Tables

```yaml
# Headers from first row (default)
results:
  range: A1:D
  type: table

# Explicit column mapping
results:
  range: A1:D
  type: table
  columns:
    A: analyte
    B: value
    C: unit
    D: flag
```

### Computed fields

```yaml
full_name:
  computed: "{first_name} {last_name}"

bmi:
  computed: "{weight} / ({height} ** 2)"
```

### Validation

```yaml
versions:
  "v1":
    fields:
      readings:
        range: D5:D
        type: list[float]
    validation:
      readings:
        min: 0
        max: 1000
```

### Discriminator

Stencil first checks the configured discriminator cells in order. If none match a version key, it falls back to inferring the version from whichever version-specific fields are most clearly populated:

```yaml
discriminator:
  cells:
    - A1

versions:
  "Report v2.0":    # matched when A1 contains "Report v2.0"
    fields: ...
  "Report v1.0":    # matched when A1 contains "Report v1.0"
    fields: ...
```

## Development

```bash
# Install everything
make install

# Run editor in browser
make dev

# Run editor as desktop app (dev mode)
make dev-app

# Build desktop app (.dmg / .exe)
make build-app

# Run Python tests
make test

# Preview a release build without tagging
make release-check VERSION=0.3.5

# Cut a real release from a git tag
make release VERSION=0.3.5

# See all commands
make help
```

## Project Structure

```
stencil/
├── editor/          # React + TypeScript + Tauri desktop app
├── stencilpy/       # Python library (Pydantic, openpyxl)
├── Makefile
└── SPEC.md          # Full specification
```
