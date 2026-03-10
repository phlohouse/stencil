# Computed Fields

Computed fields are derived from other extracted fields using expressions. They are defined with the `computed` key instead of `cell` or `range`.

## String Interpolation

For simple concatenation, use `{field_name}` references separated by whitespace:

```yaml
full_name:
  computed: "{first_name} {last_name}"
```

```python
report.full_name  # "Jane Doe"
```

stencilpy detects pure interpolation (only `{field}` references and whitespace) and performs string concatenation. `None` values are replaced with empty strings.

## Arithmetic Expressions

For calculations, use Python expressions with `{field_name}` placeholders:

```yaml
bmi:
  computed: "{weight} / ({height} ** 2)"
```

```python
report.bmi  # 22.857142857142858
```

The expression is evaluated as Python code after substituting field values using `repr()`. This means:
- Numeric fields are substituted as numbers: `70.0 / (1.75 ** 2)`
- String fields are substituted as quoted strings: `'Jane' + ' ' + 'Doe'`
- `None` values are substituted as the literal `None`

> **Note:** Computed expressions use Python's `eval()`. The YAML author is trusted — there is no sandboxing. Do not use untrusted schema files.

## Dependency Resolution

Computed fields can reference other computed fields. Dependencies are resolved automatically via topological sort:

```yaml
fields:
  width:
    cell: A1
    type: float
  height:
    cell: A2
    type: float
  area:
    computed: "{width} * {height}"
  doubled_area:
    computed: "{area} * 2"           # References another computed field
```

stencilpy evaluates `area` first, then `doubled_area`. Order in the YAML file does not matter.

## Circular Dependencies

Circular references are detected and raise a `ValueError`:

```yaml
# This will fail:
a:
  computed: "{b} + 1"
b:
  computed: "{a} + 1"
```

```
ValueError: Circular dependency detected involving 'a'
```

## Type

Computed fields default to type `any` (no coercion). The Pydantic model field will be `Any | None`.

## Error Handling

If a computed expression fails to evaluate (e.g., division by zero, type errors), a `StencilError` is raised with a descriptive message:

```
StencilError: Failed to evaluate computed expression '{weight} / ({height} ** 2)': ZeroDivisionError: float division by zero
```

## Complete Example

```yaml
versions:
  "v1.0":
    fields:
      first_name:
        cell: A1
      last_name:
        cell: B1
      weight:
        cell: C1
        type: float
      height:
        cell: D1
        type: float
      full_name:
        computed: "{first_name} {last_name}"
      bmi:
        computed: "{weight} / ({height} ** 2)"
      bmi_category:
        computed: "'Underweight' if {bmi} < 18.5 else 'Normal' if {bmi} < 25 else 'Overweight'"
```
