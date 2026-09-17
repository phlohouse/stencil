"""Apply a schema's ``validation`` rules to extracted values.

Schemas can declare ``min``, ``max``, ``pattern`` and ``required`` rules per
field.  The same rules are used to pick a schema version when a workbook is
read (see :mod:`stencilpy.versioning`); this module applies them to the
extracted values too, so out-of-range or missing data is reported instead of
silently passing through.

Enforcement is opt-in: :meth:`Stencil.extract` only checks values when called
with ``validate=True`` (``stencil extract --strict``), while ``stencil
validate`` always reports what it finds.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from .errors import ValidationError
from .schema import FieldDef


@dataclass(frozen=True)
class FieldViolation:
    """One extracted value that breaks a field's validation rule."""

    field: str
    rule: str
    value: Any
    message: str

    def __str__(self) -> str:
        return f"{self.field}: {self.message}"


def is_empty(value: Any) -> bool:
    """Return True for values that count as "no value in the workbook"."""
    if value is None:
        return True
    if isinstance(value, str):
        return not value.strip()
    if isinstance(value, (list, dict, tuple, set)):
        return len(value) == 0
    return False


def matches_scalar(field: FieldDef, value: Any) -> bool:
    """Return True when a scalar value satisfies the field's rules.

    Shared with version matching so both paths agree on what a valid value
    looks like.
    """
    return scalar_violation(field, value) is None


def scalar_violation(
    field: FieldDef,
    value: Any,
    *,
    label: str | None = None,
) -> FieldViolation | None:
    """Return the rule a scalar value breaks, or None when it passes."""
    validation = field.validation
    if validation is None:
        return None

    name = label or field.name
    if validation.min is not None and _is_number(value) and value < validation.min:
        return FieldViolation(
            name,
            "min",
            value,
            f"{value!r} is below the minimum {validation.min}",
        )
    if validation.max is not None and _is_number(value) and value > validation.max:
        return FieldViolation(
            name,
            "max",
            value,
            f"{value!r} is above the maximum {validation.max}",
        )
    if validation.pattern is not None:
        if re.match(validation.pattern, str(value)) is None:
            return FieldViolation(
                name,
                "pattern",
                value,
                f"{value!r} does not match pattern {validation.pattern!r}",
            )
    return None


def collect_violations(
    fields: Mapping[str, FieldDef],
    values: Mapping[str, Any],
) -> list[FieldViolation]:
    """Check extracted ``values`` against every field's validation rules.

    Scalar rules (``min``, ``max``, ``pattern``) apply to scalar fields and to
    each item of a list field.  Tables and dict fields only check
    ``required``: their rules are about the shape of the block, not its cells.
    """
    violations: list[FieldViolation] = []
    for name, field in fields.items():
        validation = field.validation
        if validation is None:
            continue

        value = values.get(name)
        if is_empty(value):
            if validation.required:
                violations.append(
                    FieldViolation(
                        name,
                        "required",
                        value,
                        "no value found in the workbook",
                    )
                )
            continue

        if field.is_list and isinstance(value, list):
            for index, item in enumerate(value):
                # Gaps inside a bounded range are normal; only the field as a
                # whole is checked for ``required``.
                if is_empty(item):
                    continue
                violation = scalar_violation(
                    field,
                    item,
                    label=f"{name}[{index}]",
                )
                if violation is not None:
                    violations.append(violation)
        elif field.is_table or field.is_dict:
            # Rules on a block of cells only say whether the block must exist.
            continue
        else:
            violation = scalar_violation(field, value)
            if violation is not None:
                violations.append(violation)

    return violations


def format_violations(
    violations: list[FieldViolation],
    source: str | None = None,
) -> str:
    """Render violations as a single human-readable message."""
    where = f" in '{source}'" if source else ""
    count = len(violations)
    header = (
        f"{count} validation rule failed{where}"
        if count == 1
        else f"{count} validation rules failed{where}"
    )
    lines = [f"{header}:"]
    lines.extend(f"  - {violation}" for violation in violations)
    return "\n".join(lines)


def check_values(
    fields: Mapping[str, FieldDef],
    values: Mapping[str, Any],
    source: str | None = None,
) -> None:
    """Raise :class:`ValidationError` when any value breaks its rules."""
    violations = collect_violations(fields, values)
    if violations:
        raise ValidationError(format_violations(violations, source))


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)
