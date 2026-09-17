"""Load the schemas the editor exports and extract with them.

The fixtures in ``fixtures/editor`` are written by the editor's own exporter
(``scripts/export-editor-fixtures.ts``) and regenerated in CI, so these tests fail
when the two tools drift apart — for example when the editor starts writing a key
stencilpy does not understand.
"""

from __future__ import annotations

from pathlib import Path

import openpyxl
import pytest

from stencilpy import Stencil

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "editor"


def _fixture(name: str) -> Path:
    path = FIXTURE_DIR / name
    if not path.is_file():
        pytest.skip(f"{path} is missing; run scripts/export-editor-fixtures.ts")
    return path


def _workbook(tmp_dir: Path, name: str, rows: dict[str, object]) -> Path:
    path = tmp_dir / name
    workbook = openpyxl.Workbook()
    sheet = workbook.active
    for ref, value in rows.items():
        sheet[ref] = value
    workbook.save(str(path))
    return path


def test_scalar_list_and_computed_fields(tmp_dir: Path) -> None:
    path = _workbook(
        tmp_dir,
        "scalar_and_list.xlsx",
        {
            "A1": "v1.0",
            "B1": "RPT-2291",
            "B2": "North",
            "E3": 70.0,
            "E4": 1.75,
            "D5": 1.5,
            "D6": 2.5,
            # D7 is blank: one blank row is skipped because blank_rows is 2
            "D8": 3.5,
        },
    )

    report = Stencil(_fixture("scalar_and_list.stencil.yaml")).extract(path)

    assert report.report_id == "RPT-2291"
    assert report.site == "North"
    assert report.readings == [1.5, 2.5, 3.5]
    assert report.bmi == pytest.approx(70.0 / (1.75**2))


def test_horizontal_table_from_the_editor(tmp_dir: Path) -> None:
    path = _workbook(
        tmp_dir,
        "table_horizontal.xlsx",
        {
            "A1": "v1.0",
            "A3": "Analyte",
            "B3": "Value",
            "C3": "Unit",
            "D3": "Flag",
            "A4": "Glucose",
            "B4": 95.0,
            "C4": "mg/dL",
            "D4": "normal",
            "A5": "Cholesterol",
            "B5": 180.0,
            "C5": "mg/dL",
            "D5": "high",
        },
    )

    report = Stencil(_fixture("table_horizontal.stencil.yaml")).extract(path)

    assert len(report.results_table) == 2
    assert report.results_table[0]["analyte"] == "Glucose"
    assert report.results_table[1]["flag"] == "high"


def test_vertical_table_from_the_editor(tmp_dir: Path) -> None:
    path = _workbook(
        tmp_dir,
        "table_vertical.xlsx",
        {
            "A1": "v1.0",
            "B3": "S-001",
            "C3": "S-002",
            "A4": "Hb",
            "B4": 12.4,
            "C4": 13.1,
            "A5": "WBC",
            "B5": 6.2,
            "C5": 7.0,
        },
    )

    report = Stencil(_fixture("table_vertical.stencil.yaml")).extract(path)

    assert len(report.matrix_table) == 2
    assert report.matrix_table[0]["record_name"] == "S-001"
    assert report.matrix_table[0]["hb"] == 12.4
    assert report.matrix_table[1]["wbc"] == 7.0
