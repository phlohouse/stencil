import pytest

from stencilpy.errors import StencilError
from stencilpy.schema import FieldDef, StencilSchema, ValidationDef


class TestStencilSchema:
    def test_from_dict(self, sample_schema_dict):
        schema = StencilSchema.from_dict(sample_schema_dict)
        assert schema.name == "lab_report"
        assert schema.discriminator_cell == "A1"
        assert schema.discriminator_cells == ["A1"]
        assert "v2.0" in schema.versions
        assert "v1.0" in schema.versions

    def test_from_file(self, sample_schema_yaml):
        schema = StencilSchema.from_file(sample_schema_yaml)
        assert schema.name == "lab_report"
        assert schema.source_path == sample_schema_yaml

    def test_missing_name(self):
        with pytest.raises(StencilError, match="name"):
            StencilSchema.from_dict({"discriminator": {"cell": "A1"}, "versions": {"v1": {"fields": {}}}})

    def test_missing_discriminator(self):
        with pytest.raises(StencilError, match="discriminator"):
            StencilSchema.from_dict({"name": "test", "versions": {"v1": {"fields": {}}}})

    def test_missing_versions(self):
        with pytest.raises(StencilError, match="version"):
            StencilSchema.from_dict({"name": "test", "discriminator": {"cell": "A1"}})

    def test_legacy_single_discriminator_cell_is_supported(self):
        schema = StencilSchema.from_dict(
            {"name": "test", "discriminator": {"cell": "A1"}, "versions": {"v1": {"fields": {}}}}
        )
        assert schema.discriminator_cell == "A1"
        assert schema.discriminator_cells == ["A1"]

    def test_multiple_discriminator_cells_use_first_as_primary(self):
        schema = StencilSchema.from_dict(
            {
                "name": "test",
                "discriminator": {"cells": ["J2", "Stds!O1"]},
                "versions": {"v1": {"fields": {}}},
            }
        )
        assert schema.discriminator_cell == "J2"
        assert schema.discriminator_cells == ["J2", "Stds!O1"]

    def test_file_not_found(self, tmp_dir):
        with pytest.raises(StencilError, match="not found"):
            StencilSchema.from_file(tmp_dir / "nonexistent.yaml")

    def test_version_extends(self):
        schema = StencilSchema.from_dict({
            "name": "test",
            "discriminator": {"cells": ["A1"]},
            "versions": {
                "v1.0": {
                    "fields": {
                        "name": {"cell": "A1"},
                        "age": {"cell": "B1", "type": "int"},
                    },
                },
                "v2.0": {
                    "extends": "v1.0",
                    "fields": {
                        "email": {"cell": "C1"},
                    },
                },
            },
        })
        v2 = schema.versions["v2.0"]
        assert "name" in v2.fields
        assert "age" in v2.fields
        assert "email" in v2.fields
        assert len(v2.fields) == 3

    def test_version_extends_override(self):
        schema = StencilSchema.from_dict({
            "name": "test",
            "discriminator": {"cells": ["A1"]},
            "versions": {
                "v1.0": {
                    "fields": {
                        "name": {"cell": "A1"},
                    },
                },
                "v2.0": {
                    "extends": "v1.0",
                    "fields": {
                        "name": {"cell": "B1"},
                    },
                },
            },
        })
        assert schema.versions["v2.0"].fields["name"].cell == "B1"

    def test_version_extends_chain(self):
        schema = StencilSchema.from_dict({
            "name": "test",
            "discriminator": {"cells": ["A1"]},
            "versions": {
                "v1.0": {
                    "fields": {"a": {"cell": "A1"}},
                },
                "v2.0": {
                    "extends": "v1.0",
                    "fields": {"b": {"cell": "B1"}},
                },
                "v3.0": {
                    "extends": "v2.0",
                    "fields": {"c": {"cell": "C1"}},
                },
            },
        })
        v3 = schema.versions["v3.0"]
        assert "a" in v3.fields
        assert "b" in v3.fields
        assert "c" in v3.fields

    def test_version_extends_circular(self):
        with pytest.raises(StencilError, match="Circular extends"):
            StencilSchema.from_dict({
                "name": "test",
                "discriminator": {"cells": ["A1"]},
                "versions": {
                    "v1.0": {
                        "extends": "v2.0",
                        "fields": {"a": {"cell": "A1"}},
                    },
                    "v2.0": {
                        "extends": "v1.0",
                        "fields": {"b": {"cell": "B1"}},
                    },
                },
            })

    def test_version_extends_unknown(self):
        with pytest.raises(StencilError, match="unknown version"):
            StencilSchema.from_dict({
                "name": "test",
                "discriminator": {"cells": ["A1"]},
                "versions": {
                    "v2.0": {
                        "extends": "v1.0",
                        "fields": {"a": {"cell": "A1"}},
                    },
                },
            })


class TestFieldDef:
    def test_cell_default_type(self):
        f = FieldDef(name="test", cell="A1")
        assert f.resolved_type_str == "str"
        assert f.is_scalar

    def test_range_default_type(self):
        f = FieldDef(name="test", range="A1:A10")
        assert f.resolved_type_str == "list[str]"
        assert f.is_list

    def test_explicit_type(self):
        f = FieldDef(name="test", cell="A1", type_str="float")
        assert f.resolved_type_str == "float"
        assert f.python_type == float

    def test_table_type(self):
        f = FieldDef(name="test", range="A1:D", type_str="table")
        assert f.is_table

    def test_dict_type(self):
        f = FieldDef(name="test", range="A1:B10", type_str="dict[str, str]")
        assert f.is_dict

    def test_computed(self):
        f = FieldDef(name="test", computed="{a} + {b}")
        assert f.is_computed
        assert f.resolved_type_str == "any"

    def test_no_cell_range_computed_raises(self):
        f = FieldDef(name="test")
        with pytest.raises(StencilError):
            f.resolved_type_str


class TestValidation:
    def test_validation_parsed(self, sample_schema_dict):
        schema = StencilSchema.from_dict(sample_schema_dict)
        v2 = schema.versions["v2.0"]
        readings_field = v2.fields["readings"]
        assert readings_field.validation is not None
        assert readings_field.validation.min == 0
        assert readings_field.validation.max == 1000

        name_field = v2.fields["patient_name"]
        assert name_field.validation is not None
        assert name_field.validation.pattern == "^[A-Za-z ]+$"

    def test_validation_inherited_via_extends(self):
        schema = StencilSchema.from_dict({
            "name": "test",
            "discriminator": {"cells": ["A1"]},
            "versions": {
                "v1.0": {
                    "fields": {
                        "score": {"cell": "A1", "type": "float"},
                    },
                    "validation": {
                        "score": {"min": 0, "max": 100},
                    },
                },
                "v2.0": {
                    "extends": "v1.0",
                    "fields": {
                        "name": {"cell": "B1"},
                    },
                },
            },
        })
        v2_score = schema.versions["v2.0"].fields["score"]
        assert v2_score.validation is not None
        assert v2_score.validation.min == 0
        assert v2_score.validation.max == 100
