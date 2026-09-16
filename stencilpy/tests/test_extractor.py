import datetime

import pytest

from stencilpy.extractor import extract_fields, read_cell
from stencilpy.schema import FieldDef


class TestReadCell:
    def test_read_string(self, sample_excel_v2):
        val = read_cell(sample_excel_v2, "B3")
        assert val == "Jane Doe"

    def test_read_datetime(self, sample_excel_v2):
        val = read_cell(sample_excel_v2, "B4")
        assert isinstance(val, datetime.datetime)

    def test_read_discriminator(self, sample_excel_v2):
        val = read_cell(sample_excel_v2, "A1")
        assert val == "v2.0"

    def test_read_header_value(self, sample_excel_v2):
        val = read_cell(sample_excel_v2, "header:right")
        assert val == "v2.0-header"

    def test_read_footer_value(self, sample_excel_v2):
        val = read_cell(sample_excel_v2, "footer:center")
        assert val == "footer-note"


class TestExtractFields:
    def test_cell_string(self, sample_excel_v2):
        fields = {"patient_name": FieldDef(name="patient_name", cell="B3")}
        result = extract_fields(sample_excel_v2, fields)
        assert result["patient_name"] == "Jane Doe"

    def test_cell_datetime(self, sample_excel_v2):
        fields = {"sample_date": FieldDef(name="sample_date", cell="B4", type_str="datetime")}
        result = extract_fields(sample_excel_v2, fields)
        assert isinstance(result["sample_date"], datetime.datetime)

    def test_cell_float(self, sample_excel_v2):
        fields = {"weight": FieldDef(name="weight", cell="E3", type_str="float")}
        result = extract_fields(sample_excel_v2, fields)
        assert result["weight"] == 70.0

    def test_cell_header_ref(self, sample_excel_v2):
        fields = {"header_version": FieldDef(name="header_version", cell="header:right")}
        result = extract_fields(sample_excel_v2, fields)
        assert result["header_version"] == "v2.0-header"

    def test_open_ended_list(self, sample_excel_v2):
        fields = {"readings": FieldDef(name="readings", range="D5:D", type_str="list[float]")}
        result = extract_fields(sample_excel_v2, fields)
        assert result["readings"] == [1.5, 2.3, 3.7, 0.9]

    def test_dict_extraction(self, sample_excel_v2):
        fields = {"metadata": FieldDef(name="metadata", range="A10:B12", type_str="dict[str, str]")}
        result = extract_fields(sample_excel_v2, fields)
        assert result["metadata"]["lab_id"] == "LAB-001"
        assert result["metadata"]["technician"] == "Dr. Smith"

    def test_table_with_headers(self, sample_excel_v2):
        fields = {
            "results_table": FieldDef(
                name="results_table", range="A20:D", type_str="table"
            )
        }
        result = extract_fields(sample_excel_v2, fields)
        table = result["results_table"]
        assert len(table) == 2
        assert table[0]["analyte"] == "Glucose"
        assert table[1]["flag"] == "high"

    def test_table_with_explicit_columns(self, sample_excel_v1):
        fields = {
            "results_table": FieldDef(
                name="results_table",
                range="Sheet2!A1:D",
                type_str="table",
                columns={"A": "analyte", "B": "value", "C": "unit", "D": "flag"},
            )
        }
        result = extract_fields(sample_excel_v1, fields)
        table = result["results_table"]
        assert len(table) == 2
        assert table[0]["analyte"] == "Glucose"
        assert table[1]["analyte"] == "HbA1c"

    def test_computed_fields_skipped(self, sample_excel_v2):
        fields = {
            "weight": FieldDef(name="weight", cell="E3", type_str="float"),
            "bmi": FieldDef(name="bmi", computed="{weight} / ({height} ** 2)"),
        }
        result = extract_fields(sample_excel_v2, fields)
        assert "bmi" not in result
        assert "weight" in result

    def test_v1_readings(self, sample_excel_v1):
        fields = {"readings": FieldDef(name="readings", range="C2:C", type_str="list[float]")}
        result = extract_fields(sample_excel_v1, fields)
        assert result["readings"] == [5.5, 6.1, 4.8]


class TestBlankRowTolerance:
    def test_open_ended_stops_at_first_blank_row_by_default(self, sample_excel_gaps):
        fields = {"readings": FieldDef(name="readings", range="D5:D", type_str="list[float]")}
        result = extract_fields(sample_excel_gaps, fields)
        assert result["readings"] == [1.5, 2.3]

    def test_open_ended_tolerates_single_blank_rows(self, sample_excel_gaps):
        fields = {
            "readings": FieldDef(
                name="readings", range="D5:D", type_str="list[float]", blank_rows=2
            )
        }
        result = extract_fields(sample_excel_gaps, fields)
        assert result["readings"] == [1.5, 2.3, 4.4]

    def test_open_ended_tolerates_longer_runs_within_the_limit(self, sample_excel_gaps):
        fields = {
            "readings": FieldDef(
                name="readings", range="D5:D", type_str="list[float]", blank_rows=3
            )
        }
        result = extract_fields(sample_excel_gaps, fields)
        assert result["readings"] == [1.5, 2.3, 4.4, 9.9]

    def test_table_tolerates_blank_separator_rows(self, sample_excel_gaps):
        fields = {
            "results": FieldDef(
                name="results", range="A20:B", type_str="table", blank_rows=2
            )
        }
        result = extract_fields(sample_excel_gaps, fields)
        assert [row["analyte"] for row in result["results"]] == ["Glucose", "Cholesterol"]

    def test_zero_or_negative_tolerance_falls_back_to_one(self, sample_excel_gaps):
        fields = {
            "readings": FieldDef(
                name="readings", range="D5:D", type_str="list[float]", blank_rows=0
            )
        }
        result = extract_fields(sample_excel_gaps, fields)
        assert result["readings"] == [1.5, 2.3]
