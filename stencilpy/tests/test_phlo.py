from __future__ import annotations

import datetime
import importlib.util
import json
import re
import shutil
import sys
import types
from pathlib import Path

import pandas as pd
import pytest
import sqlglot
import yaml

from stencilpy import phlo
from stencilpy.cli import main
from stencilpy.errors import StencilError
from stencilpy.schema import StencilSchema


def _write_schema(path: Path, data: dict) -> Path:
    path.write_text(yaml.safe_dump(data, sort_keys=False))
    return path


def _read(project: Path, relative: str) -> str:
    return (project / relative).read_text()


def _render_sql(sql: str) -> str:
    """Strip dbt Jinja so the statement can be parsed as plain Trino SQL."""
    sql = re.sub(r"\{\{\s*config\(.*?\)\s*\}\}", "", sql, flags=re.DOTALL)
    sql = re.sub(r"\{\{\s*source\('([^']+)',\s*'([^']+)'\)\s*\}\}", r"\1.\2", sql)
    return re.sub(r"\{\{\s*ref\('([^']+)'\)\s*\}\}", r"\1", sql)


def _load_module(path: Path, name: str) -> types.ModuleType:
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _load_generated(project: Path, domain: str, table: str) -> tuple[types.ModuleType, types.ModuleType]:
    """Import the generated Pandera schema and ingestion asset modules."""
    schema_module = _load_module(
        project / "workflows" / "schemas" / f"{domain}.py", f"workflows.schemas.{domain}"
    )
    asset_module = _load_module(
        project / "workflows" / "ingestion" / domain / f"{table}.py",
        f"workflows.ingestion.{domain}.{table}",
    )
    return asset_module, schema_module


@pytest.fixture
def project(tmp_path: Path, sample_schema_yaml: Path) -> Path:
    """Generate the Phlo files for the sample schema into an empty project."""
    out = tmp_path / "project"
    phlo.write_phlo_files(sample_schema_yaml, out)
    return out


@pytest.fixture
def phlo_stubs(monkeypatch: pytest.MonkeyPatch) -> None:
    """Stub ``dlt`` and ``phlo`` so the generated ingestion asset can be executed."""
    phlo_module = types.ModuleType("phlo")

    class _Ingest:
        @staticmethod
        def dlt(**kwargs):
            def decorator(func):
                func.phlo_kwargs = kwargs
                return func

            return decorator

    phlo_module.ingest = _Ingest()

    dlt_module = types.ModuleType("dlt")
    dlt_module.resource = lambda rows, name: list(rows)

    monkeypatch.setitem(sys.modules, "phlo", phlo_module)
    monkeypatch.setitem(sys.modules, "dlt", dlt_module)


@pytest.fixture
def extracted_rows(
    project: Path,
    tmp_path: Path,
    sample_excel_v2: Path,
    sample_excel_v1: Path,
    phlo_stubs: None,
    monkeypatch: pytest.MonkeyPatch,
) -> list[dict[str, object]]:
    """Run the generated ingestion asset over the sample workbooks."""
    input_dir = tmp_path / "data" / "lab_report"
    input_dir.mkdir(parents=True)
    shutil.copy(sample_excel_v2, input_dir / sample_excel_v2.name)
    shutil.copy(sample_excel_v1, input_dir / sample_excel_v1.name)
    monkeypatch.setenv(phlo.INPUT_DIR_ENV_VAR, str(input_dir))

    asset_module, _ = _load_generated(project, "lab_report", "lab_report")
    return asset_module._rows("2026-01-15")


class TestGeneratedLayout:
    def test_writes_expected_files(self, project: Path):
        expected = {
            "workflows/ingestion/lab_report/README.md",
            "workflows/ingestion/lab_report/__init__.py",
            "workflows/ingestion/lab_report/lab_report.py",
            "workflows/ingestion/lab_report/lab_report.stencil.yaml",
            "workflows/schemas/lab_report.py",
            "workflows/transforms/dbt/models/bronze/stg_lab_report.sql",
            "workflows/transforms/dbt/models/bronze/stg_lab_report.yml",
            "workflows/transforms/dbt/models/silver/fct_lab_report_metadata.sql",
            "workflows/transforms/dbt/models/silver/fct_lab_report_metadata.yml",
            "workflows/transforms/dbt/models/silver/fct_lab_report_readings.sql",
            "workflows/transforms/dbt/models/silver/fct_lab_report_readings.yml",
            "workflows/transforms/dbt/models/silver/fct_lab_report_results_table.sql",
            "workflows/transforms/dbt/models/silver/fct_lab_report_results_table.yml",
            "workflows/transforms/dbt/models/sources/lab_report.yml",
        }
        generated = {
            str(path.relative_to(project)) for path in project.rglob("*") if path.is_file()
        }
        assert generated == expected

    def test_copies_the_stencil_schema_next_to_the_asset(self, project: Path, sample_schema_yaml: Path):
        copied = project / "workflows" / "ingestion" / "lab_report" / "lab_report.stencil.yaml"
        assert copied.read_text() == sample_schema_yaml.read_text()

    def test_sources_yml_points_at_the_dlt_asset(self, project: Path):
        sources = yaml.safe_load(
            _read(project, "workflows/transforms/dbt/models/sources/lab_report.yml")
        )
        source = sources["sources"][0]
        assert source["name"] == "lab_report_raw"
        assert source["schema"] == "raw"
        assert source["tables"][0]["identifier"] == "lab_report"
        assert source["tables"][0]["meta"]["phlo_asset_key"] == "dlt_lab_report"

    def test_bronze_model_casts_scalars_and_keeps_json_text(self, project: Path):
        bronze = _read(project, "workflows/transforms/dbt/models/bronze/stg_lab_report.sql")
        assert "from {{ source('lab_report_raw', 'lab_report') }}" in bronze
        assert "cast(sample_date as timestamp with time zone) as sample_date," in bronze
        assert "cast(weight as double) as weight," in bronze
        assert "readings,  -- JSON text: list[float]" in bronze
        assert "bmi,  -- computed field, landed as text" in bronze
        assert "_phlo_partition_date," in bronze

    def test_silver_models_explode_each_collection(self, project: Path):
        readings = _read(project, "workflows/transforms/dbt/models/silver/fct_lab_report_readings.sql")
        assert "from {{ ref('stg_lab_report') }} as parent" in readings
        assert "as array(double))" in readings
        assert "with ordinality as entry (value, list_index)" in readings

        table = _read(project, "workflows/transforms/dbt/models/silver/fct_lab_report_results_table.sql")
        assert "as array(json))" in table
        assert "json_extract_scalar(entry.payload, '$.analyte') as analyte," in table
        assert "entry.row_index," in table

        metadata = _read(project, "workflows/transforms/dbt/models/silver/fct_lab_report_metadata.sql")
        assert "as map(varchar, varchar))" in metadata
        assert "entry.map_key," in metadata
        assert "entry.map_value" in metadata

    def test_pandera_schema_is_nullable_and_typed(self, project: Path):
        schema = _read(project, "workflows/schemas/lab_report.py")
        assert "class RawLabReport(pa.DataFrameModel):" in schema
        assert "record_id: str = pa.Field(unique=True)" in schema
        assert "sample_date: datetime | None = pa.Field(nullable=True)" in schema
        assert "weight: float | None = pa.Field(nullable=True)" in schema
        assert "readings: str | None = pa.Field(nullable=True)" in schema
        assert "bmi: str | None = pa.Field(nullable=True)" in schema

    def test_model_yml_documents_columns_and_keys(self, project: Path):
        models = "workflows/transforms/dbt/models"
        bronze = yaml.safe_load(_read(project, f"{models}/bronze/stg_lab_report.yml"))
        columns = {column["name"]: column for column in bronze["models"][0]["columns"]}
        assert bronze["models"][0]["name"] == "stg_lab_report"
        assert columns["record_id"]["tests"] == ["unique", "not_null"]
        assert columns["sample_date"]["description"] == "datetime (v2.0 cell B4)."
        description = columns["results_table"]["description"]
        assert description.startswith("table (")
        assert "v1.0 range Sheet2!A1:D" in description
        assert "v2.0 range A20:D" in description

        silver = yaml.safe_load(
            _read(project, f"{models}/silver/fct_lab_report_results_table.yml")
        )
        silver_columns = [column["name"] for column in silver["models"][0]["columns"]]
        assert silver["models"][0]["name"] == "fct_lab_report_results_table"
        assert silver_columns == ["record_id", "row_index", "analyte", "value", "unit", "flag"]

    def test_required_in_some_versions_scopes_the_not_null_test(self, project: Path):
        bronze = yaml.safe_load(
            _read(project, "workflows/transforms/dbt/models/bronze/stg_lab_report.yml")
        )
        columns = {column["name"]: column for column in bronze["models"][0]["columns"]}
        # patient_name and readings are only required by v2.0.
        assert columns["patient_name"]["tests"] == [
            {"not_null": {"config": {"where": "stencil_version in ('v2.0')"}}}
        ]
        assert columns["readings"]["tests"] == [
            {"not_null": {"config": {"where": "stencil_version in ('v2.0')"}}}
        ]
        assert "tests" not in columns["results_table"]

    def test_required_in_every_version_gets_a_plain_not_null_test(self, tmp_path: Path):
        schema_path = _write_schema(
            tmp_path / "shared.stencil.yaml",
            {
                "name": "shared",
                "discriminator": {"cells": ["A1"]},
                "versions": {
                    "v1": {
                        "fields": {
                            "always": {"cell": "B2"},
                            "late": {"cell": "B3"},
                        },
                        "validation": {"always": {"required": True}},
                    },
                    "v2": {
                        "fields": {
                            "always": {"cell": "B2"},
                            "late": {"cell": "B3"},
                        },
                        "validation": {
                            "always": {"required": True},
                            "late": {"required": True},
                        },
                    },
                },
            },
        )
        out = tmp_path / "out"
        phlo.write_phlo_files(schema_path, out)
        bronze = yaml.safe_load(
            (out / "workflows/transforms/dbt/models/bronze/stg_shared.yml").read_text()
        )
        columns = {column["name"]: column for column in bronze["models"][0]["columns"]}
        assert columns["always"]["tests"] == ["not_null"]
        assert columns["late"]["tests"] == [
            {"not_null": {"config": {"where": "stencil_version in ('v2')"}}}
        ]

    def test_generated_python_compiles(self, project: Path):
        for path in project.rglob("*.py"):
            compile(path.read_text(), str(path), "exec")

    @pytest.mark.parametrize("dialect", ["trino", "duckdb"])
    def test_generated_sql_parses_for_dialect(self, tmp_path: Path, sample_schema_yaml: Path, dialect: str):
        out = tmp_path / f"project_{dialect}"
        phlo.write_phlo_files(sample_schema_yaml, out, dialect=dialect)
        for path in sorted(out.rglob("*.sql")):
            sqlglot.parse_one(_render_sql(path.read_text()), dialect=dialect)

    def test_generated_yml_is_valid(self, project: Path):
        for path in sorted(project.rglob("*.yml")):
            assert yaml.safe_load(path.read_text())


class TestFieldProjection:
    def test_requires_a_schema_loaded_from_file(self, sample_schema_dict: dict):
        schema = StencilSchema.from_dict(sample_schema_dict)
        with pytest.raises(StencilError, match="loaded from a file"):
            phlo.build_phlo_files(schema)

    def test_header_inferred_tables_land_as_json_payload(self, tmp_path: Path):
        schema_path = _write_schema(
            tmp_path / "inferred.stencil.yaml",
            {
                "name": "inferred",
                "discriminator": {"cells": ["A1"]},
                "versions": {
                    "v1": {
                        "fields": {
                            "rows": {"range": "A1:D", "type": "table"},
                        }
                    }
                },
            },
        )
        files = phlo.build_phlo_files(StencilSchema.from_file(schema_path))
        silver = next(file for file in files if file.path.name == "fct_inferred_rows.sql")
        assert "json_format(entry.payload) as row_json" in silver.content
        assert "add columns here once the sheet headers are known" in silver.content

    def test_conflicting_types_fall_back_to_text(self, tmp_path: Path):
        schema_path = _write_schema(
            tmp_path / "conflict.stencil.yaml",
            {
                "name": "conflict",
                "discriminator": {"cells": ["A1"]},
                "versions": {
                    "v1": {
                        "fields": {
                            "amount": {"cell": "B2", "type": "int"},
                            "readings": {"range": "C2:C", "type": "list[float]"},
                        }
                    },
                    "v2": {
                        "fields": {
                            "amount": {"cell": "B2", "type": "str"},
                            "readings": {"range": "C2:C", "type": "list[str]"},
                        }
                    },
                },
            },
        )
        files = {str(file.path): file.content for file in phlo.build_phlo_files(StencilSchema.from_file(schema_path))}
        assert "amount: str | None" in files["workflows/schemas/conflict.py"]
        assert "cast(amount as" not in files["workflows/transforms/dbt/models/bronze/stg_conflict.sql"]
        assert "as array(varchar))" in files["workflows/transforms/dbt/models/silver/fct_conflict_readings.sql"]

    def test_field_names_are_normalised_into_columns(self, tmp_path: Path):
        schema_path = _write_schema(
            tmp_path / "messy.stencil.yaml",
            {
                "name": "messy",
                "discriminator": {"cells": ["A1"]},
                "versions": {
                    "v1": {
                        "fields": {
                            "Total (mg)": {"cell": "B2", "type": "float"},
                            "patientName": {"cell": "B3"},
                            "record_id": {"cell": "B4"},
                        }
                    }
                },
            },
        )
        files = {str(file.path): file.content for file in phlo.build_phlo_files(StencilSchema.from_file(schema_path))}
        schema = files["workflows/schemas/messy.py"]
        assert "total_mg: float | None" in schema
        assert "patient_name: str | None" in schema
        assert "field_record_id: str | None" in schema

        asset = files["workflows/ingestion/messy/messy.py"]
        assert '"Total (mg)": "total_mg",' in asset
        assert '"patientName": "patient_name",' in asset
        assert '"record_id": "field_record_id",' in asset

    def test_duplicate_column_names_are_suffixed(self, tmp_path: Path):
        schema_path = _write_schema(
            tmp_path / "dupes.stencil.yaml",
            {
                "name": "dupes",
                "discriminator": {"cells": ["A1"]},
                "versions": {
                    "v1": {
                        "fields": {
                            "Total (mg)": {"cell": "B2", "type": "float"},
                            "total mg": {"cell": "B3", "type": "float"},
                            "rows": {
                                "range": "A1:C",
                                "type": "table",
                                "columns": {"A": "Value", "B": "value", "C": "record_id"},
                            },
                        }
                    }
                },
            },
        )
        files = {str(file.path): file.content for file in phlo.build_phlo_files(StencilSchema.from_file(schema_path))}
        schema = files["workflows/schemas/dupes.py"]
        assert "total_mg: float | None" in schema
        assert "total_mg_2: float | None" in schema

        asset = files["workflows/ingestion/dupes/dupes.py"]
        assert '"total mg": "total_mg_2",' in asset

        silver = files["workflows/transforms/dbt/models/silver/fct_dupes_rows.sql"]
        assert "as \"Value\"" not in silver
        assert "json_extract_scalar(entry.payload, '$.Value') as value" in silver
        assert "json_extract_scalar(entry.payload, '$.value') as value_2" in silver
        assert "json_extract_scalar(entry.payload, '$.record_id') as field_record_id" in silver

    def test_rejects_reserved_table_names(self, tmp_path: Path):
        schema_path = _write_schema(
            tmp_path / "order.stencil.yaml",
            {
                "name": "order",
                "discriminator": {"cells": ["A1"]},
                "versions": {"v1": {"fields": {"total": {"cell": "B2", "type": "float"}}}},
            },
        )
        schema = StencilSchema.from_file(schema_path)
        with pytest.raises(StencilError, match="reserved word"):
            phlo.build_phlo_files(schema)
        files = {str(file.path) for file in phlo.build_phlo_files(schema, table_name="orders")}
        assert "workflows/transforms/dbt/models/bronze/stg_orders.sql" in files

    def test_table_columns_with_odd_names_use_json_path_quoting(self, tmp_path: Path):
        schema_path = _write_schema(
            tmp_path / "quoted.stencil.yaml",
            {
                "name": "quoted",
                "discriminator": {"cells": ["A1"]},
                "versions": {
                    "v1": {
                        "fields": {
                            "rows": {
                                "range": "A1:B",
                                "type": "table",
                                "columns": {"A": "value (mg/dL)", "B": "select"},
                            }
                        }
                    }
                },
            },
        )
        files = {str(file.path): file.content for file in phlo.build_phlo_files(StencilSchema.from_file(schema_path))}
        silver = files["workflows/transforms/dbt/models/silver/fct_quoted_rows.sql"]
        assert "json_extract_scalar(entry.payload, '$[\"value (mg/dL)\"]') as value_mg_d_l" in silver
        assert "json_extract_scalar(entry.payload, '$.select') as \"select\"" in silver


class TestWritePhloFiles:
    def test_refuses_to_overwrite_without_force(self, sample_schema_yaml: Path, tmp_path: Path):
        out = tmp_path / "project"
        phlo.write_phlo_files(sample_schema_yaml, out)
        with pytest.raises(StencilError, match="--force"):
            phlo.write_phlo_files(sample_schema_yaml, out)

    def test_force_overwrites_generated_files(self, sample_schema_yaml: Path, tmp_path: Path):
        out = tmp_path / "project"
        phlo.write_phlo_files(sample_schema_yaml, out)
        bronze = out / "workflows/transforms/dbt/models/bronze/stg_lab_report.sql"
        bronze.write_text("-- edited by hand")
        phlo.write_phlo_files(sample_schema_yaml, out, force=True)
        assert "Bronze staging model" in bronze.read_text()

    def test_keeps_existing_init_files(self, sample_schema_yaml: Path, tmp_path: Path):
        out = tmp_path / "project"
        init = out / "workflows/ingestion/lab_report/__init__.py"
        init.parent.mkdir(parents=True)
        init.write_text('"""Domain: lab_report"""\n# hand-written\n')
        phlo.write_phlo_files(sample_schema_yaml, out, force=True)
        assert init.read_text().endswith("# hand-written\n")

    def test_custom_table_domain_and_input_dir(self, sample_schema_yaml: Path, tmp_path: Path):
        out = tmp_path / "project"
        written = phlo.write_phlo_files(
            sample_schema_yaml,
            out,
            table_name="lab_reports_raw",
            domain="labs",
            input_dir="/mnt/uploads",
        )
        assert Path("workflows/ingestion/labs/lab_reports_raw.py") in written
        asset = _read(out, "workflows/ingestion/labs/lab_reports_raw.py")
        assert 'table_name="lab_reports_raw"' in asset
        assert 'from workflows.schemas.labs import RawLabReportsRaw' in asset
        assert 'os.environ.get("STENCIL_INPUT_DIR", "/mnt/uploads")' in asset


class TestPhloCLI:
    def test_generates_project(self, sample_schema_yaml: Path, tmp_path: Path, capsys: pytest.CaptureFixture):
        out = tmp_path / "project"
        assert main(["phlo", str(sample_schema_yaml), "--out", str(out)]) == 0
        assert (out / "workflows/schemas/lab_report.py").is_file()
        printed = capsys.readouterr().out
        assert "workflows/schemas/lab_report.py" in printed

    def test_existing_files_return_error(self, sample_schema_yaml: Path, tmp_path: Path, capsys: pytest.CaptureFixture):
        out = tmp_path / "project"
        assert main(["phlo", str(sample_schema_yaml), "--out", str(out)]) == 0
        assert main(["phlo", str(sample_schema_yaml), "--out", str(out)]) == 1
        assert "--force" in capsys.readouterr().err

    def test_missing_schema_returns_error(self, tmp_path: Path, capsys: pytest.CaptureFixture):
        assert main(["phlo", str(tmp_path / "missing.stencil.yaml")]) == 1
        assert "Error" in capsys.readouterr().err


class TestGeneratedPanderaSchema:
    @pytest.mark.parametrize(
        ("type_str", "value"),
        [
            ("str", "text"),
            ("int", 3),
            ("float", 1.5),
            ("bool", True),
            ("datetime", datetime.datetime(2026, 1, 15, 10, 30)),
            ("date", datetime.date(2026, 1, 15)),
        ],
    )
    def test_scalar_types_accept_values_and_nulls(self, tmp_path: Path, type_str: str, value: object):
        schema_path = _write_schema(
            tmp_path / f"scalars_{type_str}.stencil.yaml",
            {
                "name": "scalars",
                "discriminator": {"cells": ["A1"]},
                "versions": {"v1": {"fields": {"value_field": {"cell": "B2", "type": type_str}}}},
            },
        )
        files = {
            str(file.path): file.content
            for file in phlo.build_phlo_files(StencilSchema.from_file(schema_path))
        }
        module_path = tmp_path / "scalars_schema.py"
        module_path.write_text(files["workflows/schemas/scalars.py"])
        module = _load_module(module_path, f"generated_scalars_{type_str}")

        frame = pd.DataFrame(
            [
                {"record_id": "p:a", "source_file": "a", "stencil_version": "v1", "value_field": value},
                {"record_id": "p:b", "source_file": "b", "stencil_version": "v1", "value_field": None},
            ]
        )
        validated = module.RawScalars.validate(frame, lazy=True)
        assert validated["value_field"].iloc[0] == value
        assert pd.isna(validated["value_field"].iloc[1])


class TestDialectSelection:
    def test_unknown_dialect_is_rejected(self, sample_schema_yaml: Path, tmp_path: Path):
        with pytest.raises(StencilError, match="Unknown dialect 'bigquery'"):
            phlo.write_phlo_files(sample_schema_yaml, tmp_path / "project", dialect="bigquery")

    def test_custom_dialect_is_used(self, sample_schema_yaml: Path, tmp_path: Path):
        class CustomDialect(phlo.TrinoDialect):
            name = "custom"
            column_types = {**phlo.TrinoDialect.column_types, "float": "numeric(18, 4)"}

        out = tmp_path / "project"
        phlo.write_phlo_files(sample_schema_yaml, out, dialect=CustomDialect())
        bronze = _read(out, "workflows/transforms/dbt/models/bronze/stg_lab_report.sql")
        assert "cast(weight as numeric(18, 4)) as weight," in bronze
        assert "-- stencil phlo (custom): regenerate instead of editing." in bronze

    def test_cli_selects_the_dialect(self, sample_schema_yaml: Path, tmp_path: Path):
        out = tmp_path / "project"
        assert main(["phlo", str(sample_schema_yaml), "--out", str(out), "--dialect", "duckdb"]) == 0
        bronze = _read(out, "workflows/transforms/dbt/models/bronze/stg_lab_report.sql")
        assert "cast(sample_date as timestamptz) as sample_date," in bronze
        assert "-- stencil phlo (duckdb): regenerate instead of editing." in bronze

    def test_cli_rejects_an_unknown_dialect(self, sample_schema_yaml: Path, tmp_path: Path):
        with pytest.raises(SystemExit):
            main(["phlo", str(sample_schema_yaml), "--out", str(tmp_path), "--dialect", "bigquery"])

    def test_readme_names_the_engine(self, project: Path):
        readme = _read(project, "workflows/ingestion/lab_report/README.md")
        assert "for the `trino` engine." in readme
        assert "The dbt models target `trino`;" in readme


@pytest.fixture
def duckdb_project(tmp_path: Path, sample_schema_yaml: Path) -> Path:
    """Generate the Phlo files for the sample schema targeting DuckDB."""
    out = tmp_path / "duckdb_project"
    phlo.write_phlo_files(sample_schema_yaml, out, dialect="duckdb")
    return out


class TestDuckDbModels:
    def test_duckdb_models_use_duckdb_json_functions(self, duckdb_project: Path):
        models = "workflows/transforms/dbt/models"
        assert "cast(sample_date as timestamptz) as sample_date," in _read(
            duckdb_project, f"{models}/bronze/stg_lab_report.sql"
        )

        readings = _read(duckdb_project, f"{models}/silver/fct_lab_report_readings.sql")
        assert "cast(json(coalesce(parent.readings, '[]')) as double[])" in readings
        assert "with ordinality as entry (value, list_index)" in readings

        table = _read(duckdb_project, f"{models}/silver/fct_lab_report_results_table.sql")
        assert "json_extract_string(entry.payload, '$.analyte') as analyte," in table

        metadata = _read(duckdb_project, f"{models}/silver/fct_lab_report_metadata.sql")
        assert (
            "cross join json_each(coalesce(parent.metadata, '{}'))"
            " as entry (map_key, map_value, map_type)" in metadata
        )
        assert "json_extract_string(entry.map_value, '$') as map_value" in metadata

    def test_models_run_against_duckdb(self, duckdb_project: Path, extracted_rows: list[dict[str, object]]):
        duckdb = pytest.importorskip("duckdb")
        connection = duckdb.connect()
        connection.execute("create schema lab_report_raw")

        # The raw table carries the columns the stencil asset lands plus the
        # metadata columns Phlo appends during ingestion.
        frame = pd.DataFrame(extracted_rows)
        frame["_phlo_row_id"] = [f"row-{index}" for index in range(len(frame))]
        frame["_phlo_ingested_at"] = pd.Timestamp("2026-01-15T00:00:00Z")
        frame["_phlo_partition_date"] = "2026-01-15"
        frame["_phlo_run_id"] = "run-1"
        connection.register("rows", frame)
        connection.execute("create table lab_report_raw.lab_report as select * from rows")

        models = duckdb_project / "workflows" / "transforms" / "dbt" / "models"
        bronze = _render_sql((models / "bronze/stg_lab_report.sql").read_text())
        connection.execute(f"create view stg_lab_report as {bronze}")
        for path in sorted((models / "silver").glob("*.sql")):
            connection.execute(f"create table {path.stem} as {_render_sql(path.read_text())}")

        assert connection.sql("select count(*) from stg_lab_report").fetchone()[0] == 2
        assert connection.sql("select patient_name from stg_lab_report order by patient_name").fetchall() == [
            ("Jane Doe",),
            ("John Smith",),
        ]

        assert connection.sql(
            "select record_id, list_index, value from fct_lab_report_readings"
            " order by record_id, list_index"
        ).fetchall() == [
            ("2026-01-15:lab_v1.xlsx", 1, 5.5),
            ("2026-01-15:lab_v1.xlsx", 2, 6.1),
            ("2026-01-15:lab_v1.xlsx", 3, 4.8),
            ("2026-01-15:lab_v2.xlsx", 1, 1.5),
            ("2026-01-15:lab_v2.xlsx", 2, 2.3),
            ("2026-01-15:lab_v2.xlsx", 3, 3.7),
            ("2026-01-15:lab_v2.xlsx", 4, 0.9),
        ]

        assert connection.sql(
            "select record_id, row_index, analyte, cast(value as double) as value, unit, flag"
            " from fct_lab_report_results_table order by record_id, row_index"
        ).fetchall() == [
            ("2026-01-15:lab_v1.xlsx", 1, "Glucose", 90.0, "mg/dL", "normal"),
            ("2026-01-15:lab_v1.xlsx", 2, "HbA1c", 5.4, "%", "normal"),
            ("2026-01-15:lab_v2.xlsx", 1, "Glucose", 95.0, "mg/dL", "normal"),
            ("2026-01-15:lab_v2.xlsx", 2, "Cholesterol", 180.0, "mg/dL", "high"),
        ]

        assert connection.sql(
            "select record_id, map_key, map_value from fct_lab_report_metadata order by map_key"
        ).fetchall() == [
            ("2026-01-15:lab_v2.xlsx", "lab_id", "LAB-001"),
            ("2026-01-15:lab_v2.xlsx", "method", "HPLC"),
            ("2026-01-15:lab_v2.xlsx", "technician", "Dr. Smith"),
        ]


class TestSchemaDirectories:
    @pytest.fixture
    def schema_dir(self, tmp_path: Path, sample_schema_yaml: Path) -> Path:
        directory = tmp_path / "schemas"
        directory.mkdir()
        shutil.copy(sample_schema_yaml, directory / sample_schema_yaml.name)
        _write_schema(
            directory / "invoice.stencil.yaml",
            {
                "name": "invoice",
                "discriminator": {"cells": ["A1"]},
                "versions": {
                    "v1": {
                        "fields": {
                            "vendor": {"cell": "B2"},
                            "total": {"cell": "B3", "type": "float"},
                            "lines": {"range": "A10:C", "type": "table", "columns": {"A": "item"}},
                        }
                    }
                },
            },
        )
        return directory

    def test_generates_every_schema_in_the_directory(self, schema_dir: Path, tmp_path: Path):
        out = tmp_path / "project"
        written = phlo.write_phlo_files(schema_dir, out)

        assert Path("workflows/ingestion/lab_report/lab_report.py") in written
        assert Path("workflows/ingestion/invoice/invoice.py") in written
        assert Path("workflows/transforms/dbt/models/sources/lab_report.yml") in written
        assert Path("workflows/transforms/dbt/models/sources/invoice.yml") in written
        assert Path("workflows/transforms/dbt/models/bronze/stg_invoice.sql") in written
        assert Path("workflows/transforms/dbt/models/silver/fct_invoice_lines.sql") in written
        assert Path("workflows/ingestion/invoice/README.md") in written

    def test_schemas_keep_their_own_files(self, schema_dir: Path, tmp_path: Path):
        out = tmp_path / "project"
        phlo.write_phlo_files(schema_dir, out)

        # Neither schema's source, docs or tests overwrite the other's.
        sources = yaml.safe_load(
            _read(out, "workflows/transforms/dbt/models/sources/invoice.yml")
        )
        assert sources["sources"][0]["tables"][0]["identifier"] == "invoice"
        assert (out / "workflows/ingestion/invoice/invoice.stencil.yaml").is_file()
        assert (out / "workflows/ingestion/lab_report/lab_report.stencil.yaml").is_file()
        assert "invoice" in _read(out, "workflows/ingestion/invoice/README.md")

    def test_ignores_other_files_in_the_directory(self, schema_dir: Path, tmp_path: Path):
        (schema_dir / "notes.txt").write_text("not a schema")
        out = tmp_path / "project"
        written = phlo.write_phlo_files(schema_dir, out)
        assert Path("workflows/ingestion/notes/notes.py") not in written

    def test_empty_directory_is_rejected(self, tmp_path: Path):
        empty = tmp_path / "empty"
        empty.mkdir()
        with pytest.raises(StencilError, match="No .stencil.yaml files found"):
            phlo.write_phlo_files(empty, tmp_path / "project")

    def test_single_schema_options_are_rejected(self, schema_dir: Path, tmp_path: Path):
        with pytest.raises(StencilError, match="only apply when generating a single schema"):
            phlo.write_phlo_files(schema_dir, tmp_path / "project", table_name="everything")
        with pytest.raises(StencilError, match="only apply when generating a single schema"):
            phlo.write_phlo_files(schema_dir, tmp_path / "project", input_dir="/mnt/uploads")

    def test_conflicting_schema_names_are_rejected(self, tmp_path: Path):
        directory = tmp_path / "schemas"
        directory.mkdir()
        for name in ("a.stencil.yaml", "b.stencil.yaml"):
            _write_schema(
                directory / name,
                {
                    "name": "duplicate",
                    "discriminator": {"cells": ["A1"]},
                    "versions": {"v1": {"fields": {"value": {"cell": "B2"}}}},
                },
            )
        with pytest.raises(StencilError, match="conflicting files"):
            phlo.write_phlo_files(directory, tmp_path / "project")

    def test_directory_can_be_regenerated_with_force(self, schema_dir: Path, tmp_path: Path):
        out = tmp_path / "project"
        phlo.write_phlo_files(schema_dir, out)
        with pytest.raises(StencilError, match="--force"):
            phlo.write_phlo_files(schema_dir, out)
        assert phlo.write_phlo_files(schema_dir, out, force=True)

    def test_cli_generates_a_directory(self, schema_dir: Path, tmp_path: Path, capsys: pytest.CaptureFixture):
        out = tmp_path / "project"
        assert main(["phlo", str(schema_dir), "--out", str(out)]) == 0
        printed = capsys.readouterr().out
        assert "workflows/ingestion/invoice/invoice.py" in printed
        assert (out / "workflows/ingestion/lab_report/lab_report.py").is_file()
        assert (out / "workflows/ingestion/invoice/invoice.py").is_file()


class TestGeneratedArtifacts:
    def test_asset_extracts_one_row_per_workbook(self, extracted_rows: list[dict[str, object]]):
        rows = {row["stencil_version"]: row for row in extracted_rows}
        assert set(rows) == {"v1.0", "v2.0"}

        v2 = rows["v2.0"]
        assert v2["record_id"] == "2026-01-15:lab_v2.xlsx"
        assert v2["source_file"] == "lab_v2.xlsx"
        assert v2["patient_name"] == "Jane Doe"
        assert v2["header_version"] == "v2.0-header"
        assert json.loads(v2["readings"]) == [1.5, 2.3, 3.7, 0.9]
        assert json.loads(v2["metadata"])["lab_id"] == "LAB-001"
        assert json.loads(v2["results_table"])[0]["analyte"] == "Glucose"
        assert isinstance(v2["bmi"], str)

        v1 = rows["v1.0"]
        assert json.loads(v1["results_table"])[0]["unit"] == "mg/dL"

    def test_asset_declares_a_phlo_ingestion_asset(
        self, extracted_rows: list[dict[str, object]], project: Path
    ):
        asset_module, _ = _load_generated(project, "lab_report", "lab_report")
        assert asset_module.lab_report.phlo_kwargs == {
            "table_name": "lab_report",
            "unique_key": "record_id",
            "validation_schema": asset_module.RawLabReport,
            "group": "lab_report",
            "freshness_hours": (24, 48),
        }

    def test_generated_pandera_schema_validates_asset_rows(
        self, extracted_rows: list[dict[str, object]], project: Path
    ):
        _, schema_module = _load_generated(project, "lab_report", "lab_report")
        frame = pd.DataFrame(extracted_rows)
        validated = schema_module.RawLabReport.validate(frame, lazy=True)
        assert len(validated) == 2
        assert list(validated["record_id"]) == ["2026-01-15:lab_v1.xlsx", "2026-01-15:lab_v2.xlsx"]

    def test_asset_fails_on_unknown_versions(
        self, project: Path, tmp_path: Path, sample_excel_bad_disc: Path, phlo_stubs: None, monkeypatch
    ):
        input_dir = tmp_path / "data" / "lab_report"
        input_dir.mkdir(parents=True)
        shutil.copy(sample_excel_bad_disc, input_dir / "bad.xlsx")
        monkeypatch.setenv(phlo.INPUT_DIR_ENV_VAR, str(input_dir))
        asset_module, _ = _load_generated(project, "lab_report", "lab_report")
        with pytest.raises(RuntimeError, match="Failed to extract bad.xlsx"):
            asset_module._rows("2026-01-15")

    def test_asset_fails_when_no_workbooks_are_found(
        self, project: Path, tmp_path: Path, phlo_stubs: None, monkeypatch
    ):
        input_dir = tmp_path / "empty"
        input_dir.mkdir()
        monkeypatch.setenv(phlo.INPUT_DIR_ENV_VAR, str(input_dir))
        asset_module, _ = _load_generated(project, "lab_report", "lab_report")
        with pytest.raises(RuntimeError, match="No Excel workbooks found"):
            asset_module._rows("2026-01-15")
