# Version Detection

stencilpy uses a two-stage process to determine which schema version applies to a given Excel file.

## Stage 1: Discriminator Matching

The primary detection method. The schema defines one or more discriminator cells:

```yaml
discriminator:
  cells:
    - A1
    - Sheet2!B1
```

stencilpy reads each cell in order, converts the value to a stripped string, and checks if it matches any version key:

1. Read cell `A1` → value `"v2.0"` → matches version `"v2.0"` ✓

If the first cell doesn't match, subsequent cells are tried. The first match wins.

### How Matching Works

- Cell values are cast to `str` and stripped: `str(value).strip()`
- Empty cells produce an empty string `""`
- The resulting string must exactly match a key under `versions`
- Matching is case-sensitive: `"V2.0"` does not match `"v2.0"`

## Stage 2: Layout Inference

If no discriminator cell produces a match (e.g., the cell is empty or contains an unexpected value), stencilpy falls back to layout inference.

Layout inference works by trying to extract fields from each version definition and scoring how well the data fits:

1. For each version, iterate over all non-computed fields
2. Attempt to extract each field from the workbook
3. Check if the extracted value matches the expected type
4. Score each version: `confidence = valid_fields² / total_fields`
5. The version with the highest confidence wins
6. If two versions are tied, inference is **inconclusive** and a `VersionError` is raised

### Scoring Details

For each field, stencilpy checks:

| Field Type | Passes If |
|-----------|-----------|
| Scalar (`str`, `int`, etc.) | Value is non-empty and matches the declared Python type. Validation rules (min/max/pattern) are also checked if present. |
| List | Value is a non-empty list with at least one non-empty element |
| Dict | Value is a non-empty dict with at least one non-empty value |
| Table | Value is a non-empty list containing at least one non-empty dict |

The quadratic scoring (`valid² / total`) rewards versions where a higher proportion of fields match — a version with 10/10 fields matching scores higher than one with 10/15.

## When Detection Fails

If neither discriminator nor inference produces a match, a `VersionError` is raised:

```
VersionError: No schema version matched configured discriminator cells and
layout inference was inconclusive for 'data.xlsx'
(checked: A1='unknown_value')
```

The error message includes which cells were checked and what values were found, to aid debugging.

## Multi-Schema Detection

When a `Stencil` object is loaded with multiple schemas (via a directory), each schema is tried in turn:

1. Try schema A → discriminator match? → extract
2. Try schema B → discriminator match? → extract
3. No schema matched → raise `VersionError` from the last failure

## Tips

- **Always set a discriminator** for reliable version detection. Layout inference is a fallback, not a primary mechanism.
- **Use unique discriminator values** across versions. If your spreadsheet doesn't have a natural version indicator, add one (e.g., a hidden cell with a version string).
- **Multiple discriminator cells** are useful when different spreadsheet layouts store version info in different locations.
