# Python API Reference

## Installation

```bash
pip install stencilpy
```

Optional dependencies:

```bash
pip install stencilpy[concurrent]   # Adds tqdm for progress bars
```

## `Stencil`

The main entry point. Load one or more `.stencil.yaml` schemas and extract data from Excel files.

### Constructor

```python
from stencilpy import Stencil

# From a single schema file
stencil = Stencil("lab_report.stencil.yaml")

# From a directory of schemas (auto-detects which one matches)
stencil = Stencil("./schemas/")
```

The constructor accepts a path to either:
- A `.stencil.yaml` file
- A directory containing `.stencil.yaml` files (loads all of them)

### `Stencil.from_dir()`

Class method alternative for loading a directory:

```python
stencil = Stencil.from_dir("./schemas/")
```

Raises `StencilError` if the directory contains no `.stencil.yaml` files.

---

### `Stencil.extract()`

Extract data from Excel files. The method is overloaded — it handles single files, directories, and iterables of paths.

#### Single File

```python
report = stencil.extract("january_lab.xlsx")
# Returns: BaseModel (a Pydantic model instance)

print(report.patient_name)     # "Jane Doe"
print(report.readings)         # [1.2, 3.4, 5.6]
print(report.sample_date)      # datetime(2026, 1, 15)
print(report.model_dump())     # {"patient_name": "Jane Doe", ...}
print(report.model_dump_json())  # JSON string
```

The returned object is a dynamically-generated Pydantic `BaseModel`. It has all the standard Pydantic methods: `model_dump()`, `model_dump_json()`, `model_json_schema()`, etc.

Version is auto-detected via the discriminator cell(s). If no version matches, falls back to layout inference. If that also fails, raises `VersionError`.

#### Directory

```python
results = stencil.extract("./uploads/")
# Returns: BatchExtractionResult
```

Finds all Excel files (`.xlsx`, `.xls`, `.xlsm`, `.xlsb`) in the directory recursively, ignoring temporary files (`~$...`).

#### Iterable of Paths

```python
from pathlib import Path

results = stencil.extract(Path("./uploads").glob("*.xlsx"))
# Returns: BatchExtractionResult
```

#### Parameters

```python
stencil.extract(
    path,                          # str | Path | Iterable[str | Path]
    include="nested/*.xlsx",       # Glob pattern to filter files
    max_workers=4,                 # Max processes for concurrent extraction
    progress=True,                 # Show tqdm progress bar (default: True)
    concurrent=True,               # Use multiprocessing (default: True)
)
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `path` | `str \| Path \| Iterable` | — | File, directory, or iterable of paths |
| `include` | `str \| Iterable[str] \| None` | `None` | Glob pattern(s) to filter files in batch mode |
| `max_workers` | `int \| None` | `None` | Max worker processes. Defaults to `min(cpu_count, file_count)` |
| `progress` | `bool` | `True` | Show a tqdm progress bar during batch extraction |
| `concurrent` | `bool` | `True` | Use multiprocessing. Falls back to sequential for a single file or on bootstrap errors |

---

### `Stencil.models`

Access the generated Pydantic model classes without extracting data:

```python
stencil.models
# {"v2.0": <class 'LabReport_v2_0'>, "v1.0": <class 'LabReport_v1_0'>}

# Get JSON Schema for a version
stencil.models["v2.0"].model_json_schema()
```

---

## Batch Results

When extracting from multiple files, `extract()` returns a `BatchExtractionResult`.

### `BatchExtractionResult`

```python
results = stencil.extract(["file1.xlsx", "file2.xlsx", "bad.xlsx"])

results.files_scanned    # 3
results.has_failures     # True

results.successes        # list[ExtractionSuccess]
results.failures         # list[ExtractionFailure]
results.results          # list[ExtractionSuccess | ExtractionFailure] (original order)
```

### `ExtractionSuccess`

```python
for success in results.successes:
    success.path     # Path to the Excel file
    success.model    # The extracted Pydantic model instance
```

### `ExtractionFailure`

```python
for failure in results.failures:
    failure.path     # Path to the Excel file
    failure.error    # The StencilError that occurred
```

---

## Concurrency

Batch extraction uses `multiprocessing.ProcessPoolExecutor` by default for files > 1. Each worker process independently loads the schema and extracts a single file.

- Set `concurrent=False` to force sequential processing.
- If the process pool fails to start (common in notebooks or frozen apps), stencilpy automatically falls back to sequential extraction.
- Install `tqdm` (or `pip install stencilpy[concurrent]`) for progress bars.

---

## Type Coercion

stencilpy coerces cell values based on the declared field type:

| Declared Type | Coercion |
|--------------|----------|
| `str` | `str(value)` |
| `int` | `int(value)` |
| `float` | `float(value)` |
| `bool` | `bool(value)` |
| `datetime` | Passed through if already `datetime`, otherwise `datetime.fromisoformat(str(value))` |
| `date` | Extracted from `datetime` via `.date()`, otherwise `date.fromisoformat(str(value))` |

For list types (`list[float]`, etc.), each element in the range is coerced individually.

Unknown type strings raise a `StencilError`.

---

## Complete Example

```python
from stencilpy import Stencil, StencilError, VersionError, ValidationError

# Load schema
lab = Stencil("lab_report.stencil.yaml")

# Single extraction
try:
    report = lab.extract("january_lab.xlsx")
    print(f"Patient: {report.patient_name}")
    print(f"BMI: {report.bmi:.1f}")
    print(f"Readings: {report.readings}")

    # Serialize to dict or JSON
    data = report.model_dump()
    json_str = report.model_dump_json(indent=2)

except VersionError:
    print("Could not determine spreadsheet version")
except ValidationError:
    print("Extracted data failed validation")

# Batch extraction
results = lab.extract("./uploads/", include="*.xlsx", progress=True)
print(f"Processed {results.files_scanned} files")
print(f"Successes: {len(results.successes)}, Failures: {len(results.failures)}")

for success in results.successes:
    print(f"  {success.path.name}: {success.model.patient_name}")
for failure in results.failures:
    print(f"  {failure.path.name}: {failure.error}")
```
