"""Grid lists collect all input cells without exposing merged followers."""

import openpyxl
import pytest
import yaml

from stencilpy import Stencil
from stencilpy.errors import StencilError
from stencilpy.extractor import extract_fields
from stencilpy.schema import FieldDef, StencilSchema


def test_grid_lists_read_all_values_and_keep_default_lists_unchanged(tmp_path):
    path = tmp_path / "grid.xlsx"
    book = openpyxl.Workbook()
    sheet = book.active
    sheet["A1"] = "1"
    sheet.merge_cells("B2:C2")
    sheet["B2"], sheet["D2"], sheet["B3"], sheet["C3"], sheet["E3"] = "first", False, 0, "", "last"
    book.save(path)
    book.close()
    grid = FieldDef(name="ids", range="B2:E3", type_str="list[str]", orientation="grid")
    ordinary = FieldDef(name="first_column", range="B2:E3", type_str="list[str]")
    result = extract_fields(path, {"ids": grid, "first_column": ordinary})
    assert result == {"ids": ["first", "False", "0", "last"], "first_column": ["first", "0"]}
    schema = StencilSchema.from_dict(
        {
            "name": "grid",
            "discriminator": {"cells": ["A1"]},
            "versions": {"1": {"fields": {"ids": {"range": "B2:E3", "orientation": "grid"}}}},
        }
    )
    assert schema.uses_grid_lists
    schema_path = tmp_path / "grid.stencil.yaml"
    schema_path.write_text(
        yaml.safe_dump(
            {
                "name": "grid",
                "discriminator": {"cells": ["A1"]},
                "versions": {"1": {"fields": {"ids": {"range": "B2:E3", "orientation": "grid"}}}},
            }
        )
    )
    assert Stencil(schema_path).extract(path).ids == result["ids"]


@pytest.mark.parametrize(
    "field",
    [
        {"range": "A1:C", "type": "list[str]", "orientation": "grid"},
        {"range": "A1:C3", "type": "table", "orientation": "grid"},
        {"cell": "A1", "type": "list[str]", "orientation": "grid"},
    ],
)
def test_invalid_grid_declarations_fail(field):
    with pytest.raises(StencilError, match="Grid field"):
        StencilSchema.from_dict(
            {
                "name": "grid",
                "discriminator": {"cells": ["A1"]},
                "versions": {"1": {"fields": {"ids": field}}},
            }
        )
