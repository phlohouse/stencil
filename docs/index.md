# Stencil

> Lay a template over a spreadsheet. Extract structured data.

Stencil is a two-part system for extracting structured data from Excel files:

1. **Stencil Editor** — a desktop app (Tauri + React) for visually mapping cells and ranges in a spreadsheet to named fields, producing a `.stencil.yaml` schema.
2. **stencilpy** — a Python library that reads a `.stencil.yaml` schema and an Excel file, auto-detects the correct version, and returns a dynamically-generated [Pydantic](https://docs.pydantic.dev/) model.

## How It Works

```
┌──────────────┐      ┌─────────────────┐      ┌──────────────┐
│  Excel File  │──────│  .stencil.yaml  │──────│  Pydantic    │
│  (.xlsx)     │      │  (schema)       │      │  Model       │
└──────────────┘      └─────────────────┘      └──────────────┘
        ↑                      ↑                       ↓
   Upload to             Created in              Use in your
   stencilpy             Stencil Editor          Python code
```

1. Open an Excel file in the **Stencil Editor** and visually map cells/ranges to named fields.
2. Export the mapping as a `.stencil.yaml` file.
3. Use **stencilpy** to extract data from any Excel file that matches the schema — the correct version is auto-detected via a discriminator cell.

## Quick Start

### Python Library

```bash
pip install stencilpy
```

```python
from stencilpy import Stencil

lab = Stencil("lab_report.stencil.yaml")
report = lab.extract("january_lab.xlsx")

print(report.patient_name)    # "Jane Doe"
print(report.readings)        # [1.2, 3.4, 5.6]
print(report.model_dump())    # {"patient_name": "Jane Doe", ...}
```

### Command Line

```bash
stencil extract lab_report.stencil.yaml january_lab.xlsx
# {"patient_name": "Jane Doe", "readings": [1.2, 3.4, 5.6], ...}

stencil extract lab_report.stencil.yaml ./uploads/ --pretty
# Pretty-printed JSON array of all extracted files
```

### Stencil Editor

The editor is a Tauri desktop app. See the [Editor Guide](editor.md) for setup and usage.

## Documentation

| Page | Description |
|------|-------------|
| [Schema Reference](schema.md) | Complete `.stencil.yaml` format specification |
| [Python API](python-api.md) | `stencilpy` library usage and API reference |
| [CLI Reference](cli.md) | Command-line interface |
| [Editor Guide](editor.md) | Stencil Editor desktop app |
| [Version Detection](version-detection.md) | How discriminators and layout inference work |
| [Computed Fields](computed-fields.md) | Derived fields with expressions |
| [Batch Processing](batch-processing.md) | Extracting from many files at once |
| [Error Handling](error-handling.md) | Error types and troubleshooting |

## Requirements

- **Python library**: Python 3.10+, with `pydantic>=2.0`, `openpyxl>=3.1`, `pyyaml>=6.0`
- **Editor**: Tauri runtime (ships as a native app)
