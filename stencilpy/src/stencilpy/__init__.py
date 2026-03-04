from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path
from typing import Any, overload

from pydantic import BaseModel
from pydantic import ValidationError as PydanticValidationError

from .computed import get_computed_fields, resolve_computed
from .concurrent import extract_concurrent
from .errors import StencilError, ValidationError, VersionError
from .extractor import extract_fields, read_cell
from .models import build_all_models, get_or_create_model
from .schema import StencilSchema

__all__ = [
    "Stencil",
    "StencilError",
    "VersionError",
    "ValidationError",
]

_EXCEL_EXTENSIONS = {".xlsx", ".xls", ".xlsm", ".xlsb"}


def _find_excel_files(directory: Path) -> list[Path]:
    return sorted(
        p for p in directory.iterdir()
        if p.suffix.lower() in _EXCEL_EXTENSIONS and not p.name.startswith("~$")
    )


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

    @overload
    def extract(self, path: str | Path) -> BaseModel: ...

    @overload
    def extract(
        self,
        path: Iterable[str | Path],
        *,
        max_workers: int | None = ...,
        progress: bool = ...,
        concurrent: bool = ...,
    ) -> list[tuple[Path, BaseModel | StencilError]]: ...

    def extract(
        self,
        path: str | Path | Iterable[str | Path],
        *,
        max_workers: int | None = None,
        progress: bool = True,
        concurrent: bool = True,
    ) -> BaseModel | list[tuple[Path, BaseModel | StencilError]]:
        """Extract data from one or many Excel files.

        Parameters
        ----------
        path:
            A single Excel file path, a directory of Excel files, or an
            iterable of paths for batch extraction.
        max_workers:
            Max worker processes for batch extraction (ignored for single
            files).
        progress:
            Show a tqdm progress bar during batch extraction.
        concurrent:
            Use multiprocessing for batch extraction. Falls back to
            sequential when ``False`` or when there is only one file.

        Returns
        -------
        A single Pydantic model when given one path, or a list of
        ``(path, model | error)`` tuples when given many.
        """
        if isinstance(path, (str, Path)):
            resolved = Path(path)
            if resolved.is_dir():
                files = _find_excel_files(resolved)
                if not files:
                    raise StencilError(f"No Excel files found in {resolved}")
                return self._extract_many(
                    files,
                    max_workers=max_workers,
                    progress=progress,
                    concurrent=concurrent,
                )
            return self._extract_one(resolved)
        return self._extract_many(
            path,
            max_workers=max_workers,
            progress=progress,
            concurrent=concurrent,
        )

    def _extract_one(self, path: Path) -> BaseModel:
        for schema in self._schemas:
            try:
                return self._extract_with_schema(schema, path)
            except VersionError:
                continue
        raise VersionError(
            f"No schema version matched the discriminator in '{path}'"
        )

    def _extract_many(
        self,
        paths: Iterable[str | Path],
        *,
        max_workers: int | None = None,
        progress: bool = True,
        concurrent: bool = True,
    ) -> list[tuple[Path, BaseModel | StencilError]]:
        path_list = [Path(p) for p in paths]

        if concurrent and len(path_list) > 1:
            schema_paths = [
                s.source_path for s in self._schemas if s.source_path is not None
            ]
            if schema_paths:
                raw_results = extract_concurrent(
                    schema_paths,
                    path_list,
                    max_workers=max_workers,
                    progress=progress,
                )
                results: list[tuple[Path, BaseModel | StencilError]] = []
                for r in raw_results:
                    if r.error is not None:
                        results.append((r.path, r.error))
                    else:
                        model_cls = get_or_create_model(
                            self._schema_by_name(r.schema_name),
                            r.version_key,
                        )
                        try:
                            results.append(
                                (r.path, model_cls.model_validate(r.data))
                            )
                        except PydanticValidationError as e:
                            results.append((r.path, ValidationError(str(e))))
                return results

        # Sequential fallback
        try:
            from tqdm import tqdm as _tqdm
        except ImportError:
            _tqdm = None  # type: ignore[assignment]

        items: Iterable[Path] = path_list
        if progress and _tqdm is not None:
            items = _tqdm(path_list, desc="Extracting", unit="file")

        results: list[tuple[Path, BaseModel | StencilError]] = []
        for p in items:
            try:
                model = self._extract_one(p)
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

    def _schema_by_name(self, name: str) -> StencilSchema:
        for s in self._schemas:
            if s.name == name:
                return s
        raise StencilError(f"Schema '{name}' not found")

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
