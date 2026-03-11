from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Any

import openpyxl

from .addressing import parse_cell


_HEADER_FOOTER_REF_RE = re.compile(
    r"^(?:(?P<sheet>[^!]+)!)?"
    r"(?P<kind>header|footer)"
    r"(?::(?P<page>odd|even|first))?"
    r":(?P<section>left|center|right)$",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class HeaderFooterRef:
    sheet: str | None
    kind: str
    page: str
    section: str


def is_header_footer_ref(ref: str) -> bool:
    return _HEADER_FOOTER_REF_RE.match(ref.strip()) is not None


def read_scalar_ref(wb: openpyxl.Workbook, ref: str) -> Any:
    parsed = parse_header_footer_ref(ref)
    if parsed is None:
        addr = parse_cell(ref)
        ws = _get_sheet(wb, addr.sheet)
        return ws.cell(row=addr.row, column=addr.col).value

    ws = _get_sheet(wb, parsed.sheet)
    container_name = f"{parsed.page}{parsed.kind.title()}"
    container = getattr(ws, container_name)
    section = getattr(container, parsed.section)
    return section.text


def parse_header_footer_ref(ref: str) -> HeaderFooterRef | None:
    match = _HEADER_FOOTER_REF_RE.match(ref.strip())
    if match is None:
        return None

    return HeaderFooterRef(
        sheet=match.group("sheet"),
        kind=match.group("kind").lower(),
        page=(match.group("page") or "odd").lower(),
        section=match.group("section").lower(),
    )


def _get_sheet(wb: openpyxl.Workbook, sheet_name: str | None):
    if sheet_name is None:
        return wb.worksheets[0]
    if sheet_name not in wb.sheetnames:
        raise ValueError(f"Sheet '{sheet_name}' not found in workbook")
    return wb[sheet_name]
