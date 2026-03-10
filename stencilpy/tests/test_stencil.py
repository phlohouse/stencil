"""Integration tests for the Stencil class."""

import pytest

import stencilpy
from stencilpy import (
    BatchExtractionResult,
    ExtractionFailure,
    ExtractionSuccess,
    Stencil,
    StencilError,
    ValidationError,
    VersionError,
)


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

    def test_extract_without_discriminator_uses_layout_inference(
        self,
        sample_schema_yaml,
        sample_excel_no_disc_v2,
    ):
        stencil = Stencil(sample_schema_yaml)
        report = stencil.extract(sample_excel_no_disc_v2)
        assert report.patient_name == "Jane Doe"
        assert report.readings == [1.5, 2.3]

    def test_extract_without_discriminator_errors_when_layout_is_ambiguous(
        self,
        ambiguous_schema_yaml,
        ambiguous_excel_no_disc,
    ):
        stencil = Stencil(ambiguous_schema_yaml)
        with pytest.raises(VersionError, match="layout inference was inconclusive"):
            stencil.extract(ambiguous_excel_no_disc)

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
        assert isinstance(results, BatchExtractionResult)
        assert results.files_scanned == 2
        assert len(results.successes) == 2
        assert results.failures == []
        assert results.results[0].path == sample_excel_v2
        assert isinstance(results.results[0], ExtractionSuccess)
        assert results.results[0].model.patient_name == "Jane Doe"
        assert isinstance(results.results[1], ExtractionSuccess)
        assert results.results[1].model.patient_name == "John Smith"

    def test_batch_with_error(self, sample_schema_yaml, sample_excel_v2, sample_excel_bad_disc):
        stencil = Stencil(sample_schema_yaml)
        results = stencil.extract([sample_excel_v2, sample_excel_bad_disc])
        assert results.files_scanned == 2
        assert len(results.successes) == 1
        assert len(results.failures) == 1
        assert isinstance(results.results[0], ExtractionSuccess)
        assert results.results[0].model.patient_name == "Jane Doe"
        assert isinstance(results.results[1], ExtractionFailure)
        assert isinstance(results.results[1].error, VersionError)

    def test_batch_without_discriminator_uses_layout_inference(
        self,
        sample_schema_yaml,
        sample_excel_no_disc_v2,
    ):
        stencil = Stencil(sample_schema_yaml)
        results = stencil.extract([sample_excel_no_disc_v2], concurrent=False)
        assert len(results.successes) == 1
        assert results.successes[0].model.patient_name == "Jane Doe"

    def test_batch_include_filter_for_iterable(
        self,
        sample_schema_yaml,
        sample_excel_v2,
        sample_excel_v1,
    ):
        stencil = Stencil(sample_schema_yaml)

        results = stencil.extract(
            [sample_excel_v2, sample_excel_v1],
            include=sample_excel_v1.name,
            concurrent=False,
        )

        assert results.files_scanned == 1
        assert len(results.successes) == 1
        assert results.successes[0].path == sample_excel_v1

    def test_batch_include_filter_for_directory(
        self,
        tmp_path,
        sample_schema_yaml,
        sample_excel_v2,
        sample_excel_v1,
    ):
        batch_dir = tmp_path / "batch"
        nested_dir = batch_dir / "nested"
        nested_dir.mkdir(parents=True)
        top_level_copy = batch_dir / sample_excel_v2.name
        nested_copy = nested_dir / sample_excel_v1.name
        top_level_copy.write_bytes(sample_excel_v2.read_bytes())
        nested_copy.write_bytes(sample_excel_v1.read_bytes())

        stencil = Stencil(sample_schema_yaml)
        results = stencil.extract(batch_dir, include="nested/*.xlsx", concurrent=False)

        assert results.files_scanned == 1
        assert len(results.successes) == 1
        assert results.successes[0].path == nested_copy

    def test_batch_falls_back_to_sequential_on_bootstrap_error(
        self,
        monkeypatch: pytest.MonkeyPatch,
        sample_schema_yaml,
        sample_excel_v2,
        sample_excel_v1,
    ):
        stencil = Stencil(sample_schema_yaml)

        def raise_bootstrap_error(*args, **kwargs):
            raise RuntimeError(
                "An attempt has been made to start a new process before the "
                "current process has finished its bootstrapping phase."
            )

        monkeypatch.setattr(stencilpy, "extract_concurrent", raise_bootstrap_error)

        results = stencil.extract([sample_excel_v2, sample_excel_v1])

        assert results.files_scanned == 2
        assert len(results.successes) == 2
        assert results.successes[0].model.patient_name == "Jane Doe"
        assert results.successes[1].model.patient_name == "John Smith"

    def test_batch_does_not_hide_unrelated_runtime_errors(
        self,
        monkeypatch: pytest.MonkeyPatch,
        sample_schema_yaml,
        sample_excel_v2,
        sample_excel_v1,
    ):
        stencil = Stencil(sample_schema_yaml)

        def raise_unexpected_error(*args, **kwargs):
            raise RuntimeError("unexpected process pool failure")

        monkeypatch.setattr(stencilpy, "extract_concurrent", raise_unexpected_error)

        with pytest.raises(RuntimeError, match="unexpected process pool failure"):
            stencil.extract([sample_excel_v2, sample_excel_v1])
