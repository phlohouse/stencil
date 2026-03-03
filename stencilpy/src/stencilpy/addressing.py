from __future__ import annotations

import re
from dataclasses import dataclass


_CELL_RE = re.compile(r"^([A-Z]+)(\d+)$")


def _col_to_index(col: str) -> int:
    """Convert a column letter string (A, B, ..., Z, AA, ...) to a 1-based index."""
    result = 0
    for ch in col:
        result = result * 26 + (ord(ch) - ord("A") + 1)
    return result


def _index_to_col(index: int) -> str:
    """Convert a 1-based column index to a column letter string."""
    result = []
    while index > 0:
        index, remainder = divmod(index - 1, 26)
        result.append(chr(ord("A") + remainder))
    return "".join(reversed(result))


@dataclass(frozen=True)
class CellAddress:
    """A single cell reference, optionally sheet-qualified."""

    sheet: str | None
    col: int  # 1-based
    row: int  # 1-based

    @property
    def col_letter(self) -> str:
        return _index_to_col(self.col)


@dataclass(frozen=True)
class RangeAddress:
    """A range reference, optionally sheet-qualified. end_row=None means open-ended."""

    sheet: str | None
    start_col: int  # 1-based
    start_row: int  # 1-based
    end_col: int  # 1-based
    end_row: int | None  # None = open-ended


def parse_cell(ref: str) -> CellAddress:
    """Parse a cell reference like 'A1' or 'Sheet2!B3'."""
    sheet, cell_part = _split_sheet(ref)
    col, row = _parse_cell_part(cell_part)
    return CellAddress(sheet=sheet, col=col, row=row)


def parse_range(ref: str) -> RangeAddress:
    """Parse a range reference like 'A1:D50', 'D5:D', or 'Sheet2!A1:D50'."""
    sheet, range_part = _split_sheet(ref)

    if ":" not in range_part:
        raise ValueError(f"Invalid range reference (no ':'): {ref}")

    start_str, end_str = range_part.split(":", 1)
    start_col, start_row = _parse_cell_part(start_str)

    # Check for open-ended range (end is column-only, e.g. "D")
    if re.match(r"^[A-Z]+$", end_str):
        end_col = _col_to_index(end_str)
        end_row = None
    else:
        end_col, end_row = _parse_cell_part(end_str)

    return RangeAddress(
        sheet=sheet,
        start_col=start_col,
        start_row=start_row,
        end_col=end_col,
        end_row=end_row,
    )


def _split_sheet(ref: str) -> tuple[str | None, str]:
    """Split 'Sheet2!A1' into ('Sheet2', 'A1') or ('A1',) -> (None, 'A1')."""
    if "!" in ref:
        sheet, rest = ref.split("!", 1)
        return sheet, rest
    return None, ref


def _parse_cell_part(cell: str) -> tuple[int, int]:
    """Parse 'A1' into (col_index, row_index), both 1-based."""
    m = _CELL_RE.match(cell.upper())
    if not m:
        raise ValueError(f"Invalid cell reference: {cell}")
    col_str, row_str = m.groups()
    return _col_to_index(col_str), int(row_str)
