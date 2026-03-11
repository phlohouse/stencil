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

Click the **discriminator picker** button in the top bar, then click a cell in the spreadsheet. This cell's value will be used to match version keys.

- You can add **multiple discriminator cells** — they're checked in order during extraction
- The discriminator button shows the current cell reference (e.g. `A1`)
- Use the adjacent **Header/Footer** button to add refs like `header:right`, `footer:center`, or `Cover!header:first:right`
- The header/footer builder previews the current text for the selected sheet, page, and section before you add it

### 2. Create Versions

Use the **version bar** below the header to:

- Add new versions
- Switch between versions
- Set the discriminator value for each version (the value that cell should contain to match this version)
- Remove versions

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
| `table` | 2D range → list of row dicts |

For tables, you can set:
- **Orientation**: horizontal (default, headers in first row) or vertical (headers in first column)
- **Column mapping**: explicit column letter → field name mapping

### 4. Add Validation

The **Validation Panel** in the right sidebar lets you add per-field validation rules:

- `min` / `max` for numeric fields
- `pattern` (regex) for string fields
- `required` flag

### 5. Preview & Export

- The **YAML Preview** panel in the right sidebar shows a live preview of the generated schema
- Click **Export** to download the `.stencil.yaml` file

## Features

### Schema Suggestions

Click the **Suggest** button to automatically scan the workbook and suggest field mappings. The editor analyses cell patterns, data types, and table structures to propose fields.

- Suggestions appear in a side panel
- Accept individual suggestions or all at once
- Dismiss suggestions you don't want

### Import Existing Schemas

Click **Import** to load an existing `.stencil.yaml` file. The editor parses the YAML and populates the version manager, fields, validation, and discriminator settings.

### Field Management

In the right sidebar:
- **View** all mapped fields with their cell/range references
- **Rename** fields
- **Remove** fields
- **Click** a field to highlight its location in the spreadsheet

### Resize & Move Fields

- **Drag the edge** of a field highlight in the spreadsheet to resize its range
- **Re-select** to move a field to a new location

### Batch Extract

Switch to the **Batch Extract** tab to test your schema against multiple Excel files:

- Upload files or select a directory
- See extraction results for each file
- Identify which files fail and why

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
│   │   ├── SpreadsheetView    # Main spreadsheet renderer
│   │   ├── SuggestionPanel    # Auto-suggestion results
│   │   ├── ValidationPanel    # Per-field validation rules
│   │   ├── VersionManager     # Version tabs
│   │   └── YamlPreview        # Live YAML preview
│   ├── hooks/
│   │   ├── useSchema          # Schema state management
│   │   └── useSpreadsheet     # Spreadsheet data & selection
│   ├── lib/
│   │   ├── addressing         # Cell/range address utilities
│   │   ├── excel              # SheetJS workbook wrapper
│   │   ├── field-naming       # Auto-naming heuristics
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
