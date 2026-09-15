# stencilpy

Extract structured data from Excel files using YAML schema definitions into dynamically-generated Pydantic models.

## Installation

```bash
pip install stencilpy
```

The `stencil open` command serves the bundled editor UI locally and opens it in your browser.

## Quick Start

```python
from stencilpy import Stencil

# Load a schema
lab = Stencil("lab_report.stencil.yaml")

# Extract data — version auto-detected via discriminator
report = lab.extract("january_lab.xlsx")
print(report.patient_name)
print(report.model_dump())
```

## Schema Format

Create a `.stencil.yaml` file:

```yaml
name: lab_report
description: Monthly lab report

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
      report_version:
        cell: header:right
      footer_note:
        cell: footer:center
```

Scalar `cell` references can also target worksheet headers and footers:

- `header:left`
- `header:center`
- `header:right`
- `footer:left`
- `footer:center`
- `footer:right`
- `Sheet1!header:first:right`
- `Sheet1!footer:even:center`

These references also work in `discriminator.cells`, which is useful when a workbook version is printed in the page header/footer instead of a normal cell.

## Header And Footer References

Use header/footer refs anywhere a scalar `cell` ref is accepted.

Example: extract version text and report metadata from the page chrome.

```yaml
name: lab_report
description: Monthly lab report

discriminator:
  cells:
    - A1

versions:
  "v2.0":
    fields:
      patient_name:
        cell: B3
      report_version:
        cell: header:right
      report_title:
        cell: header:center
      generated_by:
        cell: footer:left
      footer_note:
        cell: footer:center
```

If the workbook uses separate first-page or even-page headers/footers, include the page selector:

```yaml
versions:
  "v2.0":
    fields:
      first_page_title:
        cell: header:first:center
      even_page_version:
        cell: footer:even:right
      cover_sheet_version:
        cell: Cover!header:first:right
```

Supported formats:

- `header:left`
- `header:center`
- `header:right`
- `header:first:left`
- `header:even:center`
- `footer:right`
- `footer:first:center`
- `Sheet1!header:right`
- `Sheet1!footer:even:left`

## Header-Based Version Detection

If a workbook stores its version in a header or footer instead of a normal cell, add those refs to `discriminator.cells`.

```yaml
name: lab_report
description: Monthly lab report

discriminator:
  cells:
    - A1
    - header:right
    - Cover!footer:first:center

versions:
  "v1.0":
    fields:
      patient_name:
        cell: A3
  "v2.0":
    fields:
      patient_name:
        cell: B3
```

`stencilpy` will check each discriminator ref in order until one matches a known version key.

## Phlo Export

`stencil phlo` converts a schema into the dlt ingestion asset, Pandera schema and dbt models a
[Phlo](https://github.com/phlohouse/phlo) project needs to land and model the same workbooks:

```bash
stencil phlo lab_report.stencil.yaml --out ./my-phlo-project
```

Run it against a Phlo project (or an empty directory you plan to use as one) and it writes:

| Path | Purpose |
|------|---------|
| `workflows/schemas/<domain>.py` | Pandera schema validating the raw rows |
| `workflows/ingestion/<domain>/<table>.py` | dlt ingestion asset (`dlt_<table>`) that extracts every workbook in the input directory |
| `workflows/ingestion/<domain>/<schema>.stencil.yaml` | Copy of the schema used at runtime |
| `workflows/transforms/dbt/models/bronze/stg_<table>.sql` | Typed view, one row per workbook |
| `workflows/transforms/dbt/models/silver/fct_<table>_<field>.sql` | One row per `list`, `dict` or `table` entry |
| `workflows/transforms/dbt/models/sources.yml` | dbt source for the raw table |
| `workflows/transforms/dbt/models/schema.yml` | dbt tests and column docs |
| `STENCIL.md` | Notes and next steps for the generated project |

The generated asset reads workbooks from `data/<table>` by default (override with
`STENCIL_INPUT_DIR` or `--input-dir`) and lands one raw row per workbook, keyed by `record_id`
(`<partition date>:<relative path>`), so re-running a partition is idempotent. Workbooks whose
layout matches no schema version fail the run with a `VersionError`.

Scalar fields keep their stencil types. `list`, `dict` and `table` fields land as JSON text
because Phlo's dlt integration normalises nested values into child tables, which the raw
Iceberg table cannot represent; the generated silver models explode them back into one row per
entry. Computed fields have no declared type, so they land as text.

Existing files are not overwritten unless `--force` is passed. `--table` and `--domain`
override the generated table and workflow names:

```bash
stencil phlo lab_report.stencil.yaml --out . --table lab_reports --domain labs --force
```

The same conversion is available from Python:

```python
from stencilpy.phlo import write_phlo_files

write_phlo_files("lab_report.stencil.yaml", "./my-phlo-project")
```
