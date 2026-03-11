# stencilpy

Extract structured data from Excel files using YAML schema definitions into dynamically-generated Pydantic models.

## Installation

```bash
pip install stencilpy
```

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
