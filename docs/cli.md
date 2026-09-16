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
| `--strict` | | Fail when a value breaks a field's validation rules |
| `--out` | `-o` | Write the output to a file instead of stdout |
| `--format` | `-f` | Output format: `json` (default) or `ndjson` |

---

### `stencil open`

Open the editor UI in your default browser.

```
stencil open [url]
```

If no URL is provided, the command serves the bundled editor UI from the installed package on a local loopback port and opens that URL in your browser.
When bundled UI assets are not present, `stencil open` falls back to the repo dev server at `http://localhost:5173`. In that fallback mode it will start `npm run dev` in the repo's `editor/` directory with its output suppressed, wait for the server to come up, and then open the browser. The command stays attached to the server it started so `Ctrl+C` in the terminal stops it.
If the repo is not in the current directory tree, set `STENCIL_EDITOR_DIR=/path/to/stencil/editor` to point the fallback command at the editor checkout explicitly.

#### Arguments

| Argument | Description |
|----------|-------------|
| `url` | Optional URL for the running web app |

#### Examples

```bash
# Open the bundled editor UI
stencil open

# Open a different local app
stencil open http://localhost:3000
```

The command exits with `0` when the browser launch succeeds, `1` when the editor cannot be started or Python cannot hand the URL off to a browser, and `130` when you stop a server started by the command with `Ctrl+C`.

---

## Checking a Schema

```bash
stencil validate schema.yaml                 # load the schema and list its versions
stencil validate schema.yaml workbook.xlsx   # which version matches, and which fields are empty
```

`validate` exits non-zero when the schema cannot be loaded, when a field has no
`cell`, `range` or `computed`, when no version matches the file, or when an
extracted value breaks a validation rule. With a file it prints the matched
version, whether it matched by discriminator or layout inference, which cells were
checked, which fields came back empty, and every rule the file breaks.

## Writing the Output Somewhere Else

`extract` prints JSON to stdout by default:

```bash
stencil extract schema.yaml data/ --out results/extract.json --pretty
stencil extract schema.yaml data/ --format ndjson > results.ndjson
```

`--format ndjson` writes one JSON record per line (one per file in batch mode),
which is friendlier for streaming into a queue or `jq`.

## Checking Values Against the Rules

Schema versions can declare `min`, `max`, `pattern` and `required` rules per field.
`--strict` applies all of them to the extracted values and exits non-zero when one is
broken, listing every violation in one go:

```bash
stencil extract lab_report.stencil.yaml january_lab.xlsx --strict
```

```
Error: 2 validation rules failed in 'january_lab.xlsx':
  - lab_id: no value found in the workbook
  - readings[3]: 1500.0 is above the maximum 1000
```

Without `--strict` the generated model still rejects out-of-range scalars, but
`required` and per-item list rules are not checked. In batch mode a file that fails
strict validation is reported as a failure for that file; the rest still extract.

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

# Open the editor in a browser
stencil open

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

# Open the default editor web app
stencil open

# Multiple schemas, batch extraction
stencil extract ./schemas/ ./uploads/ -p
```
