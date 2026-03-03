import pytest

from stencilpy.computed import get_field_references, resolve_computed
from stencilpy.schema import FieldDef


class TestFieldReferences:
    def test_simple(self):
        refs = get_field_references("{first_name} {last_name}")
        assert refs == ["first_name", "last_name"]

    def test_expression(self):
        refs = get_field_references("{weight} / ({height} ** 2)")
        assert refs == ["weight", "height"]

    def test_no_refs(self):
        refs = get_field_references("plain text")
        assert refs == []

    def test_duplicate_refs(self):
        refs = get_field_references("{a} + {a}")
        assert refs == ["a", "a"]


class TestResolveComputed:
    def test_string_concat(self):
        fields = {
            "full_name": FieldDef(name="full_name", computed="{first_name} {last_name}"),
        }
        values = {"first_name": "Jane", "last_name": "Doe"}
        result = resolve_computed(fields, values)
        assert result["full_name"] == "Jane Doe"

    def test_arithmetic(self):
        fields = {
            "bmi": FieldDef(name="bmi", computed="{weight} / ({height} ** 2)"),
        }
        values = {"weight": 70.0, "height": 1.75}
        result = resolve_computed(fields, values)
        assert abs(result["bmi"] - 22.857142857142858) < 0.001

    def test_dependency_chain(self):
        fields = {
            "b": FieldDef(name="b", computed="{a} * 2"),
            "c": FieldDef(name="c", computed="{b} + 1"),
        }
        values = {"a": 5}
        result = resolve_computed(fields, values)
        assert result["b"] == 10
        assert result["c"] == 11

    def test_circular_dependency(self):
        fields = {
            "a": FieldDef(name="a", computed="{b} + 1"),
            "b": FieldDef(name="b", computed="{a} + 1"),
        }
        with pytest.raises(ValueError, match="Circular"):
            resolve_computed(fields, {})

    def test_none_value(self):
        fields = {
            "result": FieldDef(name="result", computed="{missing}"),
        }
        values = {"missing": None}
        result = resolve_computed(fields, values)
        assert result["result"] is None
