from __future__ import annotations

import re
from typing import Any

from .schema import FieldDef


_FIELD_REF_RE = re.compile(r"\{(\w+)\}")


def get_computed_fields(fields: dict[str, FieldDef]) -> dict[str, FieldDef]:
    """Return only the computed fields from a field dict."""
    return {name: f for name, f in fields.items() if f.is_computed}


def resolve_computed(
    computed_fields: dict[str, FieldDef],
    extracted_values: dict[str, Any],
) -> dict[str, Any]:
    """Evaluate computed fields in dependency order and return their values."""
    order = _topological_sort(computed_fields)
    all_values = dict(extracted_values)
    results: dict[str, Any] = {}

    for name in order:
        field_def = computed_fields[name]
        value = _evaluate(field_def.computed, all_values)
        all_values[name] = value
        results[name] = value

    return results


def get_field_references(expression: str) -> list[str]:
    """Extract field references like {field_name} from an expression."""
    return _FIELD_REF_RE.findall(expression)


def _topological_sort(computed_fields: dict[str, FieldDef]) -> list[str]:
    """Sort computed fields by dependency order."""
    deps: dict[str, set[str]] = {}
    for name, field_def in computed_fields.items():
        refs = set(get_field_references(field_def.computed))
        deps[name] = refs & set(computed_fields.keys())

    visited: set[str] = set()
    order: list[str] = []
    visiting: set[str] = set()

    def visit(name: str) -> None:
        if name in visited:
            return
        if name in visiting:
            raise ValueError(f"Circular dependency detected involving '{name}'")
        visiting.add(name)
        for dep in deps.get(name, set()):
            visit(dep)
        visiting.discard(name)
        visited.add(name)
        order.append(name)

    for name in computed_fields:
        visit(name)

    return order


def _is_interpolation(expression: str) -> bool:
    """Check if expression is pure string interpolation (no operators outside refs).

    Returns True when the text between {field} references is only whitespace,
    e.g. "{first_name} {last_name}" — but NOT "{weight} / ({height} ** 2)".
    """
    stripped = _FIELD_REF_RE.sub("", expression)
    # Must have some literal text (spaces) AND only whitespace characters
    return len(stripped) > 0 and stripped.isspace()


def _evaluate(expression: str, values: dict[str, Any]) -> Any:
    """Evaluate a computed expression with {field_name} substitutions."""
    if _is_interpolation(expression):
        def str_replacer(match: re.Match) -> str:
            field_name = match.group(1)
            val = values.get(field_name)
            return str(val) if val is not None else ""
        return _FIELD_REF_RE.sub(str_replacer, expression)

    def replacer(match: re.Match) -> str:
        field_name = match.group(1)
        val = values.get(field_name)
        if val is None:
            return "None"
        return repr(val)

    code = _FIELD_REF_RE.sub(replacer, expression)

    try:
        return eval(code)  # noqa: S307 — trusted YAML author
    except Exception:
        return code
