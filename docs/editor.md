# Stencil Editor

The Stencil Editor is a desktop application for visually creating `.stencil.yaml` schemas. It's built with [Tauri](https://tauri.app/) (Rust backend) and React (TypeScript frontend).

## Overview

The editor lets you:

1. Open an Excel file and view its contents as a read-only spreadsheet
2. Click cells or drag to select ranges
3. Map selections to named fields with types
4. Configure discriminator cells for version detection
5. Manage multiple schema versions
6. Set validation rules on fields
7. Preview and export the generated YAML
8. Import existing `.stencil.yaml` schemas for editing
9. Batch-extract data using the built-in Batch Extract tab

## Getting Started

### Building from Source

The editor lives in the `editor/` directory:

```bash
cd editor
npm install
npm run tauri dev       # Development mode
npm run tauri build     # Production build
```

### Opening a File

1. Launch the editor
2. Upload an Excel file (`.xlsx`) — the spreadsheet renders in the main panel
3. You can now start mapping fields

## Core Workflow

### 1. Set the Discriminator

Click the **discriminator picker** button in the workbook toolbar, then click a cell in the spreadsheet. This cell's value will be used to match version keys.

- You can add **multiple discriminator cells** — they're checked in order during extraction
- The discriminator button shows the current cell reference (e.g. `A1`)
- Use the adjacent **Header/Footer** button to add refs like `header:right`, `footer:center`, or `Cover!header:first:right`
- The header/footer builder previews the current text for the selected sheet, page, and section before you add it

### 2. Create Versions

The **workbook toolbar** below the header holds the versions, the file actions and the
discriminator controls:

- Switch between versions by clicking a version chip; the selected chip is the editable
  discriminator value (the text that cell must contain to match this version)
- The copy button on a version adds a new version with the same fields and rules, ready to
  be adapted; the **+ Version** button adds a blank one
- Remove a version with the cross on its chip
- **New**, **Undo**, **Redo** and **Open File** sit on the right of the same row, next to
  the discriminator picker

### 3. Map Fields

With a version selected:

1. **Click** a cell to select a single cell, or **drag** to select a range
2. A **field dialog** appears — enter a field name and select the type
3. The field appears in the **right sidebar** field panel

Supported field types in the editor:

| Type | Description |
|------|-------------|
| `str`, `int`, `float`, `bool` | Scalar cell values |
| `datetime`, `date` | Date/time values |
| `list[str]`, `list[int]`, `list[float]`, `list[bool]` | 1D range → list |
| `dict[str, str]` | 2-column range → key-value pairs |
| `table` | 2D range → table |

Only types that fit the selected reference are offered: a single cell can use the
scalar types, a range can use the `list`/`dict`/`table` types. Resizing a field
across that boundary switches the type automatically (with a note in the dialog).

For tables, you can set:
- **Orientation**: horizontal (default, headers in first row) or vertical (headers in first column)
- **Column mapping**: explicit column letter → field name mapping

The selected range may start at the header row: when a column mapping is set, a first row that repeats the mapped names is treated as the header and is not extracted as a record.

### 4. Add Validation

The **Validation Panel** in the right sidebar lets you add per-field validation rules:

- `min` / `max` for numeric fields
- `pattern` (regex) for string fields
- `required` flag

These rules describe the values a version expects. stencilpy uses them to pick the right
version when a workbook has no discriminator cell, so a rule that does not match the file
can send extraction to another version.

`stencil extract --strict` also applies the rules to the extracted values and fails on
the first file that breaks one; `stencil validate <schema> <file>` reports broken rules
without extracting.

### 5. Preview & Export

- The **YAML Preview** panel at the bottom of the right sidebar shows a live preview of the
  generated schema. It starts collapsed so the field list and the report panels get the
  height; expanding it is remembered for next time.
- Click **Export** to download the `.stencil.yaml` file

## Theme

The editor ships dark and light themes built from the same token set, so both stay
readable: status colours (problems, errors, diff badges) have a light counterpart, and the
text ladder keeps helper text and placeholders legible. The theme button in the header
switches between them and the choice is remembered.

## Features

### Schema Suggestions

Click the **Suggest** button to automatically scan the workbook and suggest field mappings. The editor analyses cell patterns, data types, and table structures to propose fields.

- Suggestions appear in a side panel
- Accept individual suggestions or all at once
- Dismiss suggestions you don't want
- Tables are only suggested when the header row stands out from the rows below it, so key/value blocks (report metadata, cover sheets) are proposed as individual fields instead of tables
- Cover sheets are read in either layout: a column of labels with the values beside it, or a row of labels with the values underneath
- Header rows merged across several columns are treated as group or section titles: the row underneath them supplies the column names
- Typed column headers (dates, years) and tables with an internal spacer row are recognised; repeated header names are made unique so no column is lost

### Import Existing Schemas

Click **Import** to load an existing `.stencil.yaml` file. The editor parses the YAML and populates the version manager, fields, validation, and discriminator settings.

### Field Management

In the right sidebar:
- **View** all mapped fields with their cell/range references
- **Rename** fields
- **Remove** fields
- **Click** a field to highlight its location in the spreadsheet

### Field List

- **Filter** the list by name, reference, type or computed expression
- **↑ / ↓** move a field up or down: the order in the list is the order in the YAML
- **Duplicate** copies a field (and its table mapping) right below the original
- **Edit** and **×** open the field dialog and delete the field

### Problems

The **Problems** panel in the right sidebar flags what would otherwise fail later:

- fields that map overlapping cells (usually a field left inside a table's range)
- table column or row mappings that fall outside the table's range
- versions with an empty or repeated discriminator value
- several versions defined while the active version has no discriminator value

Click **Show** on a problem to jump to the field it belongs to.

### Resize & Move Fields

- **Drag an edge or corner handle** of a field highlight to resize its range
- **Drag the move grip** (the small dotted handle at the top-right of a field) to move
  the field. The grip appears while the pointer is over the field's cells and stays
  visible for the selected field
- Cells inside a field stay selectable, so you can drag a new range over an existing
  field without moving it. A click (no drag) on a cell inside a field defines a new
  field at that cell
- Table column/row mappings move with the range and are re-derived when the range
  shape changes; mappings that fall outside a shrunken range are dropped
- **Open-ended ranges** can tolerate blank rows inside the data: set "Stop after N
  consecutive blank rows" in the field dialog (written to the schema as `blank_rows`)
- Moving or resizing keeps the field on its sheet (`Sheet2!A1:D` stays on `Sheet2`)
- Right-click or double-click the move grip to edit or delete the field, or use the
  Edit / × buttons in the field list

### Keyboard

With the grid focused (click any cell, or it regains focus when the field dialog closes):

| Key | Action |
|-----|--------|
| Arrow keys | Move the selection |
| Shift + arrows | Extend the selection from its anchor |
| Enter | Define/edit a field for the current selection |
| Escape | Clear the selection (or cancel a drag in progress) |
| Delete / Backspace | Delete the field under the selection |
| Ctrl/Cmd + C | Copy the selected range as tab separated text |
| Ctrl/Cmd + Z | Undo the last schema change |
| Ctrl/Cmd + Shift + Z (or Ctrl + Y) | Redo |

### Versions

The version chips in the workbook toolbar let you switch versions, edit the active
version's discriminator value, and remove a version. The copy button on a version adds a
new version with the same fields and rules, ready to be adapted; give it the discriminator
value the files use.

### Undo & Redo

Every change to the schema is undoable, including accepting suggestions, deleting a field
or version, and importing a schema. Use the Undo / Redo buttons in the toolbar, the
shortcuts above, or the command palette. Undo does nothing while the field dialog is open
or while a text field has focus, so typing keeps the browser's own undo.

### Column Widths

Drag the right edge of a column header to widen a column; double-click the edge to go back
to the width stored in the workbook. Widths are remembered per sheet while the editor is open.

### Large Sheets

The grid renders only the rows and columns in view (plus a small buffer), so workbooks
with thousands of rows stay responsive and every cell is reachable. Dragging a
selection past the edge of the grid keeps scrolling, and column widths follow the
workbook's own column widths.

### Batch Extract

Switch to the **Batch Extract** tab to test your schema against multiple Excel files:

- Upload files or select a directory
- See extraction results for each file
- Identify which files fail and why

### Find in the Sheet

Press **Ctrl+F** (or **Cmd+F** on macOS) in the grid to open the find bar. It floats over
the grid, so opening it never moves the sheet or the sidebars, and it searches every cell
of the active sheet, case-insensitively by default:

- matches are highlighted in the grid and the current one is boxed
- **Enter** / **Shift+Enter** (or the Prev/Next buttons) step through the matches and wrap around
- **Match case** narrows the search
- **Escape** closes the bar and returns focus to the grid

### Large Workbooks

Opening a workbook of 20 MB or more asks for confirmation first, because the editor keeps
the whole sheet in memory and a large file can make the tab unresponsive. Cancel keeps the
current workbook; confirming loads it as usual.

### Comparing Versions

The **Version Diff** panel in the right sidebar compares two versions of the schema:

- pick **From** and **To** versions to see added, removed and changed fields
- each change names what moved (mapping, type, orientation, column map, blank rows)
- validation rule differences are listed separately
- **Show unchanged** includes fields the two versions extract identically

### Theme

Toggle between dark and light mode using the theme button (☀️/🌙) in the top bar. The preference is persisted in localStorage.

## Architecture

```
editor/
├── src/
│   ├── components/          # React components
│   │   ├── BatchExtractTab    # Batch extraction UI
│   │   ├── DiscriminatorPicker # Discriminator cell selector
│   │   ├── ExportButton       # YAML export
│   │   ├── FieldDialog        # Field creation/editing dialog
│   │   ├── FieldNameDialog    # Field rename dialog
│   │   ├── FieldPanel         # Right sidebar field list
│   │   ├── FileUpload         # Excel file upload
│   │   ├── ImportButton       # YAML import
│   │   ├── LargeFileDialog    # Confirm opening a very large workbook
│   │   ├── ProblemsPanel      # Schema problems (overlaps, version clashes)
│   │   ├── SpreadsheetView    # Main spreadsheet renderer, find bar and overlays
│   │   ├── SuggestionPanel    # Auto-suggestion results
│   │   ├── ValidationPanel    # Per-field validation rules
│   │   ├── VersionDiffPanel   # Compare two versions
│   │   ├── VersionManager     # Version tabs
│   │   └── YamlPreview        # Live YAML preview
│   ├── hooks/
│   │   ├── useSchema          # Schema state management
│   │   └── useSpreadsheet     # Spreadsheet data & selection
│   ├── lib/
│   │   ├── addressing         # Cell/range address utilities
│   │   ├── excel              # SheetJS workbook wrapper
│   │   ├── field-naming       # Auto-naming heuristics
│   │   ├── file-guard         # Large workbook guard rails
│   │   ├── find               # Find-in-sheet matching
│   │   ├── schema-diff        # Version comparison
│   │   ├── storage            # localStorage persistence
│   │   ├── suggestions        # Workbook scanning for auto-suggestions
│   │   ├── types              # TypeScript type definitions
│   │   └── yaml-export        # YAML serialization/parsing
│   ├── App.tsx                # Root component
│   └── main.tsx               # Entry point
├── src-tauri/                 # Rust/Tauri backend
├── package.json
└── vite.config.ts
```

### Key Libraries

- **React** — UI framework
- **Tauri** — Desktop app shell (Rust)
- **SheetJS (xlsx)** — Excel file parsing in the browser
- **js-yaml** — YAML serialization
- **Tailwind CSS** — Styling
