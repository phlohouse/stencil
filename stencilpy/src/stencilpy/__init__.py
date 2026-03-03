from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path
from typing import Any

from pydantic import BaseModel
from pydantic import ValidationError as PydanticValidationError

from .computed import get_computed_fields, resolve_computed
from .errors import StencilError, ValidationError, VersionError
from .extractor import extract_fields, read_cell
from .models import build_all_models, get_or_create_model
from .schema import StencilSchema

__all__ = ["Stencil", "StencilError", "VersionError", "ValidationError"]


class Stencil:
    """Main entry point for stencilpy. Load a schema and extract data from Excel files."""

    def __init__(self, path: str | Path) -> None:
        self._schemas: list[StencilSchema] = []
        path = Path(path)
        if path.is_dir():
            self._load_dir(path)
        else:
            self._schemas.append(StencilSchema.from_file(path))
        self._model_cache: dict[str, dict[str, type[BaseModel]]] = {}

    @classmethod
    def from_dir(cls, path: str | Path) -> Stencil:
        """Load all .stencil.yaml files from a directory."""
        instance = cls.__new__(cls)
        instance._schemas = []
        instance._model_cache = {}
        instance._load_dir(Path(path))
        return instance

    def _load_dir(self, path: Path) -> None:
        files = sorted(path.glob("*.stencil.yaml"))
        if not files:
            raise StencilError(f"No .stencil.yaml files found in {path}")
        for f in files:
            self._schemas.append(StencilSchema.from_file(f))

    def extract(self, path: str | Path) -> BaseModel:
        """Extract data from an Excel file, auto-detecting version via discriminator."""
        path = Path(path)

        for schema in self._schemas:
            try:
                return self._extract_with_schema(schema, path)
            except VersionError:
                continue

        raise VersionError(
            f"No schema version matched the discriminator in '{path}'"
        )

    def extract_batch(
        self, paths: Iterable[Path]
    ) -> list[tuple[Path, BaseModel | StencilError]]:
        """Extract data from multiple Excel files."""
        results = []
        for p in paths:
            try:
                model = self.extract(p)
                results.append((p, model))
            except StencilError as e:
                results.append((p, e))
        return results

    @property
    def models(self) -> dict[str, type[BaseModel]]:
        """Return dict of version -> model class for all schemas."""
        result: dict[str, type[BaseModel]] = {}
        for schema in self._schemas:
            models = self._get_models(schema)
            result.update(models)
        return result

    def _get_models(self, schema: StencilSchema) -> dict[str, type[BaseModel]]:
        if schema.name not in self._model_cache:
            self._model_cache[schema.name] = build_all_models(schema)
        return self._model_cache[schema.name]

    def _extract_with_schema(
        self, schema: StencilSchema, excel_path: Path
    ) -> BaseModel:
        disc_value = read_cell(excel_path, schema.discriminator_cell)
        disc_str = str(disc_value).strip() if disc_value is not None else ""

        matched_version = None
        for ver_key in schema.versions:
            if disc_str == ver_key:
                matched_version = ver_key
                break

        if matched_version is None:
            raise VersionError(
                f"Discriminator '{disc_str}' doesn't match any version "
                f"in schema '{schema.name}'"
            )

        version_def = schema.versions[matched_version]
        model_cls = get_or_create_model(schema, matched_version)

        # Extract non-computed fields
        raw_values = extract_fields(excel_path, version_def.fields)

        # Evaluate computed fields
        computed_fields = get_computed_fields(version_def.fields)
        if computed_fields:
            computed_values = resolve_computed(computed_fields, raw_values)
            raw_values.update(computed_values)

        # Build and validate model
        try:
            return model_cls.model_validate(raw_values)
        except PydanticValidationError as e:
            raise ValidationError(str(e)) from e
