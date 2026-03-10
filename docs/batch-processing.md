# Batch Processing

stencilpy supports extracting data from many Excel files at once, with concurrent processing, progress tracking, and structured error handling.

## Basic Usage

### From a Directory

```python
from stencilpy import Stencil

lab = Stencil("lab_report.stencil.yaml")
results = lab.extract("./uploads/")
```

This recursively finds all Excel files (`.xlsx`, `.xls`, `.xlsm`, `.xlsb`) in the directory, ignoring temporary files (names starting with `~$`).

### From an Iterable

```python
from pathlib import Path

files = list(Path("./data").glob("*.xlsx"))
results = lab.extract(files)
```

### From the CLI

```bash
stencil extract schema.yaml ./uploads/ --pretty --no-progress
```

## Working with Results

`extract()` returns a `BatchExtractionResult` when given multiple files:

```python
results = lab.extract("./uploads/")

# Summary
print(f"Scanned: {results.files_scanned}")
print(f"Passed: {len(results.successes)}")
print(f"Failed: {len(results.failures)}")
print(f"Any failures? {results.has_failures}")

# Iterate successes
for success in results.successes:
    print(f"{success.path.name}: {success.model.patient_name}")

# Iterate failures
for failure in results.failures:
    print(f"{failure.path.name}: {failure.error}")

# Original order (mixed successes and failures)
for result in results.results:
    from stencilpy import ExtractionSuccess, ExtractionFailure
    if isinstance(result, ExtractionSuccess):
        print(f"✓ {result.path.name}")
    elif isinstance(result, ExtractionFailure):
        print(f"✗ {result.path.name}: {result.error}")
```

## Filtering Files

Use the `include` parameter to filter which files are processed:

```python
# By filename pattern
results = lab.extract("./uploads/", include="2026-*.xlsx")

# By path pattern (for nested directories)
results = lab.extract("./uploads/", include="reports/*.xlsx")

# Multiple patterns
results = lab.extract(files, include=["january_*.xlsx", "february_*.xlsx"])
```

Patterns use `fnmatch` glob syntax and match against both the filename and the full relative path.

## Concurrency

By default, batch extraction uses Python's `multiprocessing.ProcessPoolExecutor` when processing more than one file.

```python
# Control max worker processes
results = lab.extract("./uploads/", max_workers=4)

# Disable concurrency
results = lab.extract("./uploads/", concurrent=False)
```

### How It Works

1. Each file is processed in a separate worker process
2. Workers independently load the schema and extract data
3. Raw extracted values (dicts) are returned to the main process
4. The main process reconstructs Pydantic models from the raw values

### Automatic Fallback

If the process pool fails to start (common in Jupyter notebooks, frozen applications, or environments without `fork`), stencilpy automatically falls back to sequential extraction. This is transparent — you get the same results either way.

### Progress Bars

Install `tqdm` for progress bars:

```bash
pip install stencilpy[concurrent]
```

```python
# Shown by default when tqdm is installed
results = lab.extract("./uploads/")

# Suppress progress bar
results = lab.extract("./uploads/", progress=False)
```

## Error Handling

Batch extraction **does not stop on errors**. Each file is processed independently:

- Successful extractions → `ExtractionSuccess` with the Pydantic model
- Failed extractions → `ExtractionFailure` with the `StencilError`

This means you always get results for every file, even if some fail.

```python
results = lab.extract("./uploads/")

if results.has_failures:
    for f in results.failures:
        print(f"Failed: {f.path} — {f.error}")

# Process only successes
data = [s.model.model_dump() for s in results.successes]
```

## Converting to Common Formats

```python
import json
import csv

results = lab.extract("./uploads/")

# To JSON
data = [s.model.model_dump() for s in results.successes]
print(json.dumps(data, indent=2, default=str))

# To CSV (flat fields only)
if results.successes:
    fields = list(results.successes[0].model.model_fields.keys())
    with open("output.csv", "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        for s in results.successes:
            writer.writerow(s.model.model_dump())
```
