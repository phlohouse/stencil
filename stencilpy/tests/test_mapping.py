import hashlib
import json

import openpyxl
import pytest
import yaml
from PIL import Image

from stencilpy.cli import main
from stencilpy.errors import StencilError
from stencilpy.mapping import MapSource, render_maps


@pytest.fixture
def map_source(tmp_path):
    schema = tmp_path / "example.stencil.yaml"
    schema.write_text(
        yaml.safe_dump(
            {
                "name": "example",
                "discriminator": {"cells": ["A1"]},
                "versions": {
                    "v1": {
                        "fields": {
                            "assay_id": {"cell": "B2"},
                            "standards": {
                                "range": "A5:C6",
                                "type": "table",
                                "columns": {"A": "standard_id", "C": "value"},
                                "allow_sparse_columns": True,
                            },
                            "legacy": {"range": "A8:C9", "type": "table"},
                            "readings": {"range": "E5:E", "type": "list[float]"},
                        }
                    }
                },
            }
        )
    )
    workbook = tmp_path / "first.xlsx"
    book = openpyxl.Workbook()
    sheet = book.active
    sheet["A1"] = "v1"
    sheet.merge_cells("B2:D2")
    sheet["B2"] = "<Example & assay>"
    sheet["A4"], sheet["C4"] = "Standard", "Result"
    sheet.merge_cells("A5:B5")
    sheet.merge_cells("A6:B6")
    sheet["A5"], sheet["C5"] = "S1", 12.5
    sheet["A6"], sheet["C6"] = "S2", 10
    sheet["A8"], sheet["C8"] = "Header", "Value"
    sheet["A9"], sheet["C9"] = "L1", 2
    sheet["E5"] = 1.5
    book.save(workbook)
    book.close()
    return MapSource(schema, workbook)


def test_render_merged_columns_legacy_headers_and_open_ranges(map_source, tmp_path):
    paths = [map_source.schema, map_source.workbook]
    before = [hashlib.sha256(p.read_bytes()).hexdigest() for p in paths]
    output = render_maps([map_source], tmp_path / "maps.html")
    html = output.read_text()
    manifest = json.loads((tmp_path / "maps_assets/manifest.json").read_text())
    page = manifest[0]
    assert page["merged_highlights"]["assay_id"]["display"] == "B2:D2"
    assert page["table_columns"]["standards"] == {"A:B": "standard_id", "C": "value"}
    assert page["physical_table_columns"]["legacy"] == {}
    assert page["mapped_columns"] == 2
    assert page["values_drawn"] >= 10
    assert len(page["review_fields"]) == 4
    with Image.open(tmp_path / "maps_assets" / page["png"]) as image:
        assert f'width="{image.width}" height="{image.height}"' in html
    assert "data:image/png;base64," in html
    assert 'class="range-review"' in html
    assert "<select" not in html
    assert before == [hashlib.sha256(p.read_bytes()).hexdigest() for p in paths]


def test_batch_cli_keeps_same_version_examples_separate(map_source, tmp_path):
    second = tmp_path / "second.xlsx"
    second.write_bytes(map_source.workbook.read_bytes())
    output = tmp_path / "batch.html"
    assert (
        main(
            [
                "map",
                "--source",
                str(map_source.schema),
                str(map_source.workbook),
                "--source",
                str(map_source.schema),
                str(second),
                "--out",
                str(output),
            ]
        )
        == 0
    )
    manifest = json.loads((tmp_path / "batch_assets/manifest.json").read_text())
    assert len({page["png"] for page in manifest}) == 2
    assert len({page["review_fields"][0]["id"] for page in manifest}) == 2


def test_map_rejects_invalid_inputs(map_source, tmp_path, capsys):
    with pytest.raises(ValueError, match="at least one"):
        render_maps([], tmp_path / "empty.html")
    with pytest.raises(StencilError, match="Duplicate"):
        render_maps([map_source, map_source], tmp_path / "duplicate.html")
    assert (
        main(
            [
                "map",
                "--source",
                str(tmp_path / "missing.yaml"),
                str(map_source.workbook),
                "--out",
                str(tmp_path / "missing.html"),
            ]
        )
        == 1
    )
    assert "Error:" in capsys.readouterr().err


def test_populated_unmapped_column_is_reported(map_source, tmp_path):
    book = openpyxl.load_workbook(map_source.workbook)
    book.active.unmerge_cells("A5:B5")
    book.active["B5"] = "unmapped value"
    book.save(map_source.workbook)
    book.close()
    with pytest.raises(StencilError, match="Unmapped populated"):
        render_maps([map_source], tmp_path / "invalid.html")


def test_cli_explains_missing_optional_renderer(monkeypatch, tmp_path, capsys):
    import builtins

    original_import = builtins.__import__

    def without_renderer(name, *args, **kwargs):
        if name == "mapping":
            raise ModuleNotFoundError("No module named 'PIL'", name="PIL")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", without_renderer)
    assert (
        main(
            [
                "map",
                "--source",
                "schema.yaml",
                "example.xlsx",
                "--out",
                str(tmp_path / "map.html"),
            ]
        )
        == 1
    )
    assert "stencilpy[report]" in capsys.readouterr().err


def test_vertical_record_mappings_are_labelled_by_row(map_source, tmp_path):
    schema = yaml.safe_load(map_source.schema.read_text())
    schema["versions"]["v1"]["fields"] = {
        "records": {
            "range": "A4:C6",
            "type": "table",
            "orientation": "vertical",
            "columns": {"4": "name", "5": "sample_id", "6": "result"},
        }
    }
    map_source.schema.write_text(yaml.safe_dump(schema))
    output = render_maps([map_source], tmp_path / "vertical.html")
    manifest = json.loads((tmp_path / "vertical_assets/manifest.json").read_text())[0]
    assert manifest["table_columns"]["records"] == {
        "4": "name",
        "5": "sample_id",
        "6": "result",
    }
    assert manifest["table_orientations"]["records"] == "vertical"
    assert manifest["mapped_columns"] == 3
    assert output.exists()
