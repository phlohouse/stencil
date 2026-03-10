import json

import pytest

from stencilpy.cli import main


class TestCLI:
    def test_no_command_returns_1(self):
        assert main([]) == 1

    def test_extract_single_file(self, sample_schema_yaml, sample_excel_v2, capsys):
        result = main(["extract", str(sample_schema_yaml), str(sample_excel_v2)])
        assert result == 0
        output = json.loads(capsys.readouterr().out)
        assert output["patient_name"] == "Jane Doe"

    def test_extract_pretty(self, sample_schema_yaml, sample_excel_v2, capsys):
        result = main(["extract", str(sample_schema_yaml), str(sample_excel_v2), "--pretty"])
        assert result == 0
        raw = capsys.readouterr().out
        assert "\n" in raw
        output = json.loads(raw)
        assert output["patient_name"] == "Jane Doe"

    def test_extract_forced_version(self, sample_schema_yaml, sample_excel_v2, capsys):
        result = main(["extract", str(sample_schema_yaml), str(sample_excel_v2), "--version", "v2.0"])
        assert result == 0
        output = json.loads(capsys.readouterr().out)
        assert output["patient_name"] == "Jane Doe"

    def test_extract_forced_version_unknown(self, sample_schema_yaml, sample_excel_v2, capsys):
        result = main(["extract", str(sample_schema_yaml), str(sample_excel_v2), "--version", "v99"])
        assert result == 1
        assert "not found" in capsys.readouterr().err

    def test_extract_bad_file(self, sample_schema_yaml, sample_excel_bad_disc, capsys):
        result = main(["extract", str(sample_schema_yaml), str(sample_excel_bad_disc)])
        assert result == 1
        assert "Error" in capsys.readouterr().err

    def test_extract_directory(self, sample_schema_yaml, sample_excel_v2, sample_excel_v1, tmp_path, capsys):
        batch_dir = tmp_path / "batch"
        batch_dir.mkdir()
        (batch_dir / sample_excel_v2.name).write_bytes(sample_excel_v2.read_bytes())
        (batch_dir / sample_excel_v1.name).write_bytes(sample_excel_v1.read_bytes())
        result = main(["extract", str(sample_schema_yaml), str(batch_dir), "--no-progress"])
        assert result == 0
        output = json.loads(capsys.readouterr().out)
        assert isinstance(output, list)
        assert len(output) == 2

    def test_extract_schema_not_found(self, tmp_path, capsys):
        result = main(["extract", str(tmp_path / "nope.yaml"), str(tmp_path / "nope.xlsx")])
        assert result == 1
        assert "Error" in capsys.readouterr().err
