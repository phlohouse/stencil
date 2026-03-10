# Error Handling

stencilpy uses a hierarchy of exception classes for different error scenarios. All exceptions inherit from `StencilError`.

## Exception Hierarchy

```
StencilError
├── VersionError
└── ValidationError
```

## `StencilError`

The base exception class. Raised for general errors like:

- Schema file not found
- Invalid YAML schema structure
- Missing required schema fields (`name`, `discriminator`, `versions`)
- No `.stencil.yaml` files found in a directory
- No Excel files found in a directory
- Unknown field types
- Failed computed field evaluation
- Circular `extends` chains

```python
from stencilpy import StencilError

try:
    stencil = Stencil("nonexistent.yaml")
except StencilError as e:
    print(e)  # "Schema file not found: nonexistent.yaml"
```

## `VersionError`

Raised when stencilpy cannot determine which schema version applies to an Excel file. This happens when:

1. No discriminator cell value matches any version key
2. Layout inference is inconclusive (tied scores or no fields match)

```python
from stencilpy import VersionError

try:
    report = stencil.extract("unknown_format.xlsx")
except VersionError as e:
    print(e)
    # "No schema version matched configured discriminator cells and
    #  layout inference was inconclusive for 'unknown_format.xlsx'
    #  (checked: A1='unexpected_value')"
```

The error message includes which cells were checked and what values were found.

## `ValidationError`

Raised when extracted data fails Pydantic validation. This wraps Pydantic's own `ValidationError` with details about which fields failed:

```python
from stencilpy import ValidationError

try:
    report = stencil.extract("bad_data.xlsx")
except ValidationError as e:
    print(e)
    # Includes Pydantic's detailed validation error output
```

Common causes:
- A field with `required: true` validation has a `None` value
- A numeric field violates `min` / `max` constraints
- A string field doesn't match a `pattern` regex

## Catching All Errors

Since `VersionError` and `ValidationError` both inherit from `StencilError`, you can catch them all at once:

```python
from stencilpy import Stencil, StencilError

stencil = Stencil("schema.yaml")

try:
    report = stencil.extract("data.xlsx")
except StencilError as e:
    print(f"Extraction failed: {e}")
```

Or handle each type specifically:

```python
from stencilpy import Stencil, StencilError, VersionError, ValidationError

try:
    report = stencil.extract("data.xlsx")
except VersionError:
    print("Could not determine spreadsheet version")
except ValidationError:
    print("Data failed validation")
except StencilError:
    print("Something else went wrong")
```

## Batch Error Handling

During batch extraction, errors are captured per-file rather than raised. See [Batch Processing](batch-processing.md) for details.

```python
results = stencil.extract("./uploads/")

for failure in results.failures:
    print(f"{failure.path}: {failure.error}")
    print(f"  Error type: {type(failure.error).__name__}")
```

## Troubleshooting

### "No schema version matched"

- Check that the discriminator cell contains the expected version string
- Verify the version key in your YAML exactly matches the cell value (case-sensitive)
- Add more discriminator cells if the version indicator is in different locations across files

### "Schema file not found"

- Check the path to your `.stencil.yaml` file
- The path can be relative or absolute

### "No .stencil.yaml files found"

- When using `Stencil("./dir/")` or `Stencil.from_dir()`, the directory must contain files ending in `.stencil.yaml`

### "Failed to evaluate computed expression"

- Check that all referenced fields exist and have the expected types
- Verify the Python expression syntax is correct
- Check for division by zero or other runtime errors

### "Unknown scalar type"

- Check for typos in the `type` field of your schema (e.g. `flaot` instead of `float`)
- See the [Schema Reference](schema.md) for supported types
