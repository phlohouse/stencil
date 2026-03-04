"""Integration tests for the Stencil class."""

import pytest

from stencilpy import Stencil, StencilError, VersionError, ValidationError


class TestStencilSingleSchema:
    def test_extract_v2(self, sample_schema_yaml, sample_excel_v2):
        stencil = Stencil(sample_schema_yaml)
        report = stencil.extract(sample_excel_v2)
        assert report.patient_name == "Jane Doe"
        assert len(report.readings) == 4
        assert report.readings[0] == 1.5

    def test_extract_v2_datetime(self, sample_schema_yaml, sample_excel_v2):
        stencil = Stencil(sample_schema_yaml)
        report = stencil.extract(sample_excel_v2)
        import datetime
        assert isinstance(report.sample_date, datetime.datetime)

    def test_extract_v2_metadata(self, sample_schema_yaml, sample_excel_v2):
        stencil = Stencil(sample_schema_yaml)
        report = stencil.extract(sample_excel_v2)
        assert report.metadata["lab_id"] == "LAB-001"

    def test_extract_v2_table(self, sample_schema_yaml, sample_excel_v2):
        stencil = Stencil(sample_schema_yaml)
        report = stencil.extract(sample_excel_v2)
        assert len(report.results_table) == 2
        assert report.results_table[0]["analyte"] == "Glucose"

    def test_extract_v2_computed_bmi(self, sample_schema_yaml, sample_excel_v2):
        stencil = Stencil(sample_schema_yaml)
        report = stencil.extract(sample_excel_v2)
        expected_bmi = 70.0 / (1.75**2)
        assert abs(report.bmi - expected_bmi) < 0.001

    def test_extract_v2_model_dump(self, sample_schema_yaml, sample_excel_v2):
        stencil = Stencil(sample_schema_yaml)
        report = stencil.extract(sample_excel_v2)
        dumped = report.model_dump()
        assert isinstance(dumped, dict)
        assert "patient_name" in dumped
        assert "bmi" in dumped

    def test_extract_v1(self, sample_schema_yaml, sample_excel_v1):
        stencil = Stencil(sample_schema_yaml)
        report = stencil.extract(sample_excel_v1)
        assert report.patient_name == "John Smith"
        assert report.readings == [5.5, 6.1, 4.8]

    def test_extract_v1_table_with_columns(self, sample_schema_yaml, sample_excel_v1):
        stencil = Stencil(sample_schema_yaml)
        report = stencil.extract(sample_excel_v1)
        assert len(report.results_table) == 2
        assert report.results_table[0]["analyte"] == "Glucose"

    def test_version_error(self, sample_schema_yaml, sample_excel_bad_disc):
        stencil = Stencil(sample_schema_yaml)
        with pytest.raises(VersionError):
            stencil.extract(sample_excel_bad_disc)

    def test_models_property(self, sample_schema_yaml):
        stencil = Stencil(sample_schema_yaml)
        models = stencil.models
        assert "v2.0" in models
        assert "v1.0" in models


class TestStencilFromDir:
    def test_from_dir(self, schema_dir, sample_excel_v2):
        stencil = Stencil.from_dir(schema_dir)
        report = stencil.extract(sample_excel_v2)
        assert report.patient_name == "Jane Doe"

    def test_from_dir_constructor(self, schema_dir, sample_excel_v2):
        stencil = Stencil(schema_dir)
        report = stencil.extract(sample_excel_v2)
        assert report.patient_name == "Jane Doe"

    def test_empty_dir(self, tmp_dir):
        empty = tmp_dir / "empty"
        empty.mkdir()
        with pytest.raises(StencilError, match="No .stencil.yaml"):
            Stencil.from_dir(empty)


class TestExtractBatch:
    def test_batch_success(self, sample_schema_yaml, sample_excel_v2, sample_excel_v1):
        stencil = Stencil(sample_schema_yaml)
        results = stencil.extract([sample_excel_v2, sample_excel_v1])
        assert len(results) == 2
        assert results[0][0] == sample_excel_v2
        assert results[0][1].patient_name == "Jane Doe"
        assert results[1][1].patient_name == "John Smith"

    def test_batch_with_error(self, sample_schema_yaml, sample_excel_v2, sample_excel_bad_disc):
        stencil = Stencil(sample_schema_yaml)
        results = stencil.extract([sample_excel_v2, sample_excel_bad_disc])
        assert len(results) == 2
        assert hasattr(results[0][1], "patient_name")
        assert isinstance(results[1][1], VersionError)
