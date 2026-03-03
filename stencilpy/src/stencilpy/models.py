from __future__ import annotations

import datetime
import re
from typing import Any

from pydantic import BaseModel, Field, create_model

from .schema import FieldDef, StencilSchema, TYPE_MAP


_MODEL_CACHE: dict[str, type[BaseModel]] = {}


def get_or_create_model(
    schema: StencilSchema, version_key: str
) -> type[BaseModel]:
    """Get or create a Pydantic model class for a schema version."""
    cache_key = f"{schema.name}:{version_key}"
    if cache_key in _MODEL_CACHE:
        return _MODEL_CACHE[cache_key]

    version = schema.versions[version_key]
    field_definitions: dict[str, Any] = {}

    for name, field_def in version.fields.items():
        python_type = field_def.python_type
        field_kwargs = _build_field_kwargs(field_def)

        # Make all fields optional with None default since Excel cells may be empty
        if field_def.validation and field_def.validation.required:
            field_definitions[name] = (python_type | None, Field(default=None, **field_kwargs))
        else:
            field_definitions[name] = (python_type | None, Field(default=None, **field_kwargs))

    class_name = _make_class_name(schema.name, version_key)
    model_cls = create_model(class_name, **field_definitions)
    _MODEL_CACHE[cache_key] = model_cls
    return model_cls


def build_all_models(schema: StencilSchema) -> dict[str, type[BaseModel]]:
    """Build Pydantic model classes for all versions in a schema."""
    return {
        ver_key: get_or_create_model(schema, ver_key)
        for ver_key in schema.versions
    }


def _build_field_kwargs(field_def: FieldDef) -> dict[str, Any]:
    """Build Pydantic Field() keyword arguments from validation constraints."""
    kwargs: dict[str, Any] = {}
    if field_def.validation and field_def.is_scalar:
        v = field_def.validation
        if v.min is not None:
            kwargs["ge"] = v.min
        if v.max is not None:
            kwargs["le"] = v.max
        if v.pattern is not None:
            kwargs["pattern"] = v.pattern
    return kwargs


def _make_class_name(schema_name: str, version_key: str) -> str:
    """Generate a valid Python class name from schema name and version."""
    name_part = re.sub(r"[^a-zA-Z0-9]", "_", schema_name).title().replace("_", "")
    ver_part = re.sub(r"[^a-zA-Z0-9]", "_", version_key)
    return f"{name_part}_{ver_part}"
