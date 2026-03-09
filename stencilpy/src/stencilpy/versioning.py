from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import openpyxl

from .addressing import parse_cell
from .errors import VersionError
from .extractor import (
    _extract_field,
    _get_sheet,
    _read_cell_value,
)
from .schema import FieldDef, StencilSchema


@dataclass(frozen=True)
class CheckedCell:
    cell: str
    value: str


@dataclass(frozen=True)
class ResolvedVersion:
    version_key: str
    matched_cell: str | None
    checked_cells: list[CheckedCell]
    matched_by: str


def resolve_version(schema: StencilSchema, excel_path: str | Path) -> ResolvedVersion:
    wb = openpyxl.load_workbook(str(excel_path), read_only=True, data_only=True)
    try:
        checked_cells: list[CheckedCell] = []

        for cell_ref in schema.discriminator_cells:
            try:
                discriminator_value = _read_discriminator_value(wb, cell_ref)
            except Exception as exc:
                checked_cells.append(CheckedCell(cell=cell_ref, value=f"<error: {exc}>"))
                continue

            checked_cells.append(CheckedCell(cell=cell_ref, value=discriminator_value))
            if discriminator_value in schema.versions:
                return ResolvedVersion(
                    version_key=discriminator_value,
                    matched_cell=cell_ref,
                    checked_cells=checked_cells,
                    matched_by="discriminator",
                )

        inferred_version = _infer_version_from_layout(schema, wb)
        if inferred_version is not None:
            return ResolvedVersion(
                version_key=inferred_version,
                matched_cell=None,
                checked_cells=checked_cells,
                matched_by="inference",
            )
    finally:
        wb.close()

    checked_summary = ", ".join(f"{item.cell}={item.value!r}" for item in checked_cells) or "<none>"
    raise VersionError(
        "No schema version matched configured discriminator cells and layout inference "
        f"was inconclusive for '{excel_path}' (checked: {checked_summary})"
    )


def _read_discriminator_value(wb: openpyxl.Workbook, cell_ref: str) -> str:
    addr = parse_cell(cell_ref)
    ws = _get_sheet(wb, addr.sheet)
    value = _read_cell_value(ws, addr.row, addr.col)
    if value is None:
        return ""
    return str(value).strip()


def _infer_version_from_layout(
    schema: StencilSchema,
    wb: openpyxl.Workbook,
) -> str | None:
    candidates: list[tuple[float, str]] = []

    for version_key, version in schema.versions.items():
        total_fields = 0
        valid_fields = 0

        for field in version.fields.values():
            if field.is_computed or (field.cell is None and field.range is None):
                continue
            total_fields += 1
            if _field_extracts_with_expected_type(wb, field):
                valid_fields += 1

        if total_fields == 0 or valid_fields == 0:
            continue

        confidence = (valid_fields * valid_fields) / total_fields
        candidates.append((confidence, version_key))

    if not candidates:
        return None

    candidates.sort(reverse=True)
    best_confidence, best_version = candidates[0]
    if len(candidates) > 1 and abs(best_confidence - candidates[1][0]) < 1e-9:
        return None
    return best_version


def _field_extracts_with_expected_type(wb: openpyxl.Workbook, field: FieldDef) -> bool:
    try:
        value = _extract_field(wb, field)
    except Exception:
        return False

    if field.is_table:
        return isinstance(value, list) and any(isinstance(row, dict) and row for row in value)
    if field.is_dict:
        return isinstance(value, dict) and any(_has_value(item) for item in value.values())
    if field.is_list:
        return isinstance(value, list) and any(_has_value(item) for item in value)
    if field.is_scalar:
        if not _has_value(value):
            return False
        return _passes_scalar_validation(field, value)
    return _has_value(value)


def _passes_scalar_validation(field: FieldDef, value: object) -> bool:
    if not isinstance(value, field.python_type):
        return False
    validation = field.validation
    if validation is None:
        return True
    if validation.min is not None and value < validation.min:
        return False
    if validation.max is not None and value > validation.max:
        return False
    if validation.pattern is not None:
        import re

        return re.match(validation.pattern, str(value)) is not None
    return True


def _has_value(value: object) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    return True
