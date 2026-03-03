import pytest

from stencilpy.errors import StencilError
from stencilpy.schema import FieldDef, StencilSchema, ValidationDef


class TestStencilSchema:
    def test_from_dict(self, sample_schema_dict):
        schema = StencilSchema.from_dict(sample_schema_dict)
        assert schema.name == "lab_report"
        assert schema.discriminator_cell == "A1"
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

    def test_file_not_found(self, tmp_dir):
        with pytest.raises(StencilError, match="not found"):
            StencilSchema.from_file(tmp_dir / "nonexistent.yaml")


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
