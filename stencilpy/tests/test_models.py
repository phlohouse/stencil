import datetime
from typing import Any

import pytest
from pydantic import BaseModel

from stencilpy.models import build_all_models, get_or_create_model, _MODEL_CACHE
from stencilpy.schema import StencilSchema


class TestModelGeneration:
    def test_creates_model(self, sample_schema_dict):
        _MODEL_CACHE.clear()
        schema = StencilSchema.from_dict(sample_schema_dict)
        model_cls = get_or_create_model(schema, "v2.0")
        assert issubclass(model_cls, BaseModel)

    def test_model_has_fields(self, sample_schema_dict):
        _MODEL_CACHE.clear()
        schema = StencilSchema.from_dict(sample_schema_dict)
        model_cls = get_or_create_model(schema, "v2.0")
        field_names = set(model_cls.model_fields.keys())
        assert "patient_name" in field_names
        assert "sample_date" in field_names
        assert "readings" in field_names
        assert "bmi" in field_names

    def test_model_instantiation(self, sample_schema_dict):
        _MODEL_CACHE.clear()
        schema = StencilSchema.from_dict(sample_schema_dict)
        model_cls = get_or_create_model(schema, "v2.0")
        instance = model_cls(
            patient_name="Test",
            sample_date=datetime.datetime(2024, 1, 1),
            readings=[1.0, 2.0],
            results_table=[{"a": 1}],
            metadata={"k": "v"},
            weight=70.0,
            height=1.75,
            bmi="22.86",
        )
        assert instance.patient_name == "Test"

    def test_build_all_models(self, sample_schema_dict):
        _MODEL_CACHE.clear()
        schema = StencilSchema.from_dict(sample_schema_dict)
        models = build_all_models(schema)
        assert "v2.0" in models
        assert "v1.0" in models

    def test_model_caching(self, sample_schema_dict):
        _MODEL_CACHE.clear()
        schema = StencilSchema.from_dict(sample_schema_dict)
        m1 = get_or_create_model(schema, "v2.0")
        m2 = get_or_create_model(schema, "v2.0")
        assert m1 is m2

    def test_model_dump(self, sample_schema_dict):
        _MODEL_CACHE.clear()
        schema = StencilSchema.from_dict(sample_schema_dict)
        model_cls = get_or_create_model(schema, "v1.0")
        instance = model_cls(
            patient_name="John",
            readings=[1.0],
            results_table=[],
        )
        dumped = instance.model_dump()
        assert dumped["patient_name"] == "John"
