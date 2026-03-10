# CLI Reference

stencilpy includes a command-line interface for extracting data from Excel files without writing Python code. It's installed automatically with the package.

## Installation

```bash
pip install stencilpy
```

The `stencil` command is available after installation.

## Commands

### `stencil extract`

Extract data from Excel files using a YAML schema.

```
stencil extract <schema> <path> [options]
```

#### Arguments

| Argument | Description |
|----------|-------------|
| `schema` | Path to a `.stencil.yaml` file or a directory containing schema files |
| `path` | Path to an Excel file or a directory of Excel files |

#### Options

| Option | Short | Description |
|--------|-------|-------------|
| `--pretty` | `-p` | Pretty-print JSON output with 2-space indentation |
| `--version` | `-v` | Force a specific schema version (skip discriminator detection) |
| `--include` | `-i` | Glob pattern to filter files in batch mode |
| `--no-progress` | | Suppress the tqdm progress bar during batch extraction |

---

## Single File Extraction

Extracts data and prints a JSON object to stdout:

```bash
stencil extract lab_report.stencil.yaml january_lab.xlsx
```

```json
{"patient_name": "Jane Doe", "readings": [1.2, 3.4, 5.6], "sample_date": "2026-01-15 10:30:00"}
```

With pretty-printing:

```bash
stencil extract lab_report.stencil.yaml january_lab.xlsx --pretty
```

```json
{
  "patient_name": "Jane Doe",
  "readings": [1.2, 3.4, 5.6],
  "sample_date": "2026-01-15 10:30:00"
}
```

### Forcing a Version

Skip discriminator detection and use a specific version:

```bash
stencil extract lab_report.stencil.yaml data.xlsx --version v2.0
```

---

## Batch Extraction

Point at a directory to extract from all Excel files:

```bash
stencil extract lab_report.stencil.yaml ./uploads/ --pretty --no-progress
```

Output is a JSON array. Each element contains either `data` (success) or `error` (failure):

```json
[
  {
    "file": "uploads/january.xlsx",
    "data": {
      "patient_name": "Jane Doe",
      "readings": [1.2, 3.4]
    }
  },
  {
    "file": "uploads/bad_file.xlsx",
    "error": "No schema version matched ..."
  }
]
```

- Successful extractions include a `"data"` key with the model dump.
- Failed extractions include an `"error"` key with the error message.
- Errors for individual files are also printed to **stderr**.

### Filtering Files

Use `--include` to process only files matching a glob pattern:

```bash
stencil extract schema.yaml ./uploads/ --include "2026-*.xlsx"
stencil extract schema.yaml ./uploads/ --include "reports/*.xlsx"
```

---

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | All extractions succeeded |
| `1` | One or more extractions failed, or a fatal error occurred |

---

## Using with Pipes

The CLI outputs clean JSON to stdout, making it easy to pipe into other tools:

```bash
# Extract and process with jq
stencil extract schema.yaml data.xlsx | jq '.patient_name'

# Batch extract to a file
stencil extract schema.yaml ./uploads/ --pretty --no-progress > results.json

# Extract and load in another Python script
stencil extract schema.yaml data.xlsx | python -c "import sys, json; print(json.load(sys.stdin)['readings'])"
```

---

## Schema Directory

You can point at a directory of schemas instead of a single file. stencilpy will load all `.stencil.yaml` files and try each one:

```bash
stencil extract ./schemas/ mystery_file.xlsx
```

---

## Examples

```bash
# Basic extraction
stencil extract lab.stencil.yaml sample.xlsx

# Pretty JSON output
stencil extract lab.stencil.yaml sample.xlsx -p

# Force version
stencil extract lab.stencil.yaml sample.xlsx -v v1.0

# Batch with filter and no progress bar
stencil extract lab.stencil.yaml ./data/ -i "*.xlsx" --no-progress -p

# Multiple schemas, batch extraction
stencil extract ./schemas/ ./uploads/ -p
```
