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
  cell: A1

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
```
