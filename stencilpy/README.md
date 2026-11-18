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

## Visual schema maps

Install the optional PNG renderer:

```bash
pip install 'stencilpy[report]'
stencil map --source lab_report.stencil.yaml january_lab.xlsx --out maps.html
```

Repeat `--source SCHEMA WORKBOOK` to combine schemas or example versions on one page.
Versions are detected from each workbook. The command writes a standalone HTML file
with embedded PNGs, plus `maps_assets/` containing the PNGs and a JSON manifest.

Images show worksheet contents, highlighted source ranges and field keys at native
pixel size. Explicit table column mappings appear above their source columns.
Merged columns share one label. Vertical tables show their row mappings. Tables without explicit column mappings retain
only their original worksheet headers. Formula cells use saved values without
recalculation. Large `Raw_Data` sheets show a preview around their mapped cells.
Only mapped worksheets appear; embedded charts and images are not rendered.

Click a field label to request removal or a range change. Copy requests from
**Review summary**. Reviews persist in browser storage where available; they do
not modify schemas. Workbooks are opened for reading and never saved. Generated
reports contain example contents, so share them only with suitable recipients.
Re-running the command replaces the output HTML and matching PNG assets.

The same renderer is available from Python:

```python
from stencilpy.mapping import MapSource, render_maps

render_maps([
    MapSource("lab_report.stencil.yaml", "january_lab.xlsx"),
    MapSource("lab_report.stencil.yaml", "february_lab.xlsx"),
], "maps.html")
```

## Lists across a grid

Ordinary list ranges read their first column. Use `orientation: grid` to collect
all non-empty values from a bounded rectangle in row order:

```yaml
study_ids:
  range: Samples & Dilutions!B2:F3
  type: list[str]
  orientation: grid
```

Merged cells contribute their anchor value once. Empty cells are skipped; zero
and false values are retained. A grid produces one list with one field name.

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

Pass a directory instead of a file to generate artifacts for every `.stencil.yaml` in it:

```bash
stencil phlo ./schemas --out ./my-phlo-project
```

Run it against a Phlo project (or an empty directory you plan to use as one) and it writes:

| Path | Purpose |
|------|---------|
| `workflows/schemas/<domain>.py` | Pandera schema validating the raw rows |
| `workflows/ingestion/<domain>/<table>.py` | dlt ingestion asset (`dlt_<table>`) that extracts every workbook in the input directory |
| `workflows/ingestion/<domain>/<schema>.stencil.yaml` | Copy of the schema used at runtime |
| `workflows/ingestion/<domain>/README.md` | Notes and next steps for this schema |
| `workflows/transforms/dbt/models/sources/<table>.yml` | dbt source for the raw table |
| `workflows/transforms/dbt/models/bronze/stg_<table>.sql` | Typed view, one row per workbook |
| `workflows/transforms/dbt/models/silver/fct_<table>_<field>.sql` | One row per `list`, `dict` or `table` entry |

dbt tests and column docs sit next to each model as `.yml` files, and every generated file belongs
to a single schema, so several schemas can share one project without overwriting each other.
Schemas with the same name are rejected.

The generated asset reads workbooks from `data/<table>` by default (override with
`STENCIL_INPUT_DIR` or `--input-dir`) and lands one raw row per workbook, keyed by `record_id`
(`<partition date>:<relative path>`), so re-running a partition is idempotent. Workbooks whose
layout matches no schema version fail the run with a `VersionError`. `--table`, `--domain` and
`--input-dir` only apply when generating a single schema file.

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

### Dialects

The dbt models target Trino by default, the engine Phlo's dbt profile uses. Pass `--dialect` to
generate them for another engine:

```bash
stencil phlo lab_report.stencil.yaml --out . --dialect duckdb
```

| Dialect | Engine | Notes |
|---------|--------|-------|
| `trino` | Trino (default) | JSON text exploded with `json_parse`/`json_extract_scalar` and `unnest(...) with ordinality` |
| `duckdb` | DuckDB | For local analysis with `dbt-duckdb` or the DuckDB CLI; uses `json_extract_string`, `json_each` and `unnest(...) with ordinality` |

Only the dbt SQL depends on the dialect: the dlt asset, Pandera schema, `sources.yml` and
`schema.yml` are the same for every engine. `build_phlo_files`/`write_phlo_files` also accept a
`PhloDialect` instance, so another engine can be supported by subclassing `PhloDialect` (column
types, identifier quoting, JSON extraction and the join that explodes a collection).

Note that Trino casts JSON array elements individually, turning uncastable elements into `NULL`,
while DuckDB raises a conversion error instead.
