import pytest

from stencilpy.addressing import (
    CellAddress,
    RangeAddress,
    _col_to_index,
    _index_to_col,
    parse_cell,
    parse_range,
)


class TestColConversion:
    def test_single_letters(self):
        assert _col_to_index("A") == 1
        assert _col_to_index("B") == 2
        assert _col_to_index("Z") == 26

    def test_double_letters(self):
        assert _col_to_index("AA") == 27
        assert _col_to_index("AZ") == 52
        assert _col_to_index("BA") == 53

    def test_roundtrip(self):
        for i in range(1, 100):
            assert _col_to_index(_index_to_col(i)) == i


class TestParseCell:
    def test_simple(self):
        addr = parse_cell("A1")
        assert addr == CellAddress(sheet=None, col=1, row=1)

    def test_larger(self):
        addr = parse_cell("B3")
        assert addr == CellAddress(sheet=None, col=2, row=3)

    def test_double_letter(self):
        addr = parse_cell("AA12")
        assert addr == CellAddress(sheet=None, col=27, row=12)

    def test_sheet_qualified(self):
        addr = parse_cell("Sheet2!B3")
        assert addr == CellAddress(sheet="Sheet2", col=2, row=3)

    def test_col_letter_property(self):
        addr = parse_cell("D5")
        assert addr.col_letter == "D"

    def test_invalid(self):
        with pytest.raises(ValueError):
            parse_cell("123")

    def test_invalid_no_row(self):
        with pytest.raises(ValueError):
            parse_cell("A")


class TestParseRange:
    def test_bounded(self):
        rng = parse_range("A1:D50")
        assert rng == RangeAddress(sheet=None, start_col=1, start_row=1, end_col=4, end_row=50)

    def test_single_column_bounded(self):
        rng = parse_range("A1:A50")
        assert rng == RangeAddress(sheet=None, start_col=1, start_row=1, end_col=1, end_row=50)

    def test_single_row_range(self):
        rng = parse_range("A1:D1")
        assert rng == RangeAddress(sheet=None, start_col=1, start_row=1, end_col=4, end_row=1)

    def test_open_ended(self):
        rng = parse_range("D5:D")
        assert rng == RangeAddress(sheet=None, start_col=4, start_row=5, end_col=4, end_row=None)

    def test_open_ended_multi_col(self):
        rng = parse_range("A1:D")
        assert rng == RangeAddress(sheet=None, start_col=1, start_row=1, end_col=4, end_row=None)

    def test_sheet_qualified(self):
        rng = parse_range("Sheet2!A1:D50")
        assert rng == RangeAddress(sheet="Sheet2", start_col=1, start_row=1, end_col=4, end_row=50)

    def test_sheet_qualified_open_ended(self):
        rng = parse_range("Sheet2!A1:D")
        assert rng == RangeAddress(sheet="Sheet2", start_col=1, start_row=1, end_col=4, end_row=None)

    def test_no_colon_raises(self):
        with pytest.raises(ValueError, match="no ':'"):
            parse_range("A1")
