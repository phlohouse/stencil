from __future__ import annotations

import datetime
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from .errors import StencilError


# Mapping of type strings to Python types
TYPE_MAP: dict[str, Any] = {
    "str": str,
    "int": int,
    "float": float,
    "bool": bool,
    "datetime": datetime.datetime,
    "date": datetime.date,
    "any": Any,
    "list[str]": list[str],
    "list[int]": list[int],
    "list[float]": list[float],
    "list[bool]": list[bool],
    "table": list[dict[str, Any]],
    "dict[str, str]": dict[str, str],
}

SCALAR_TYPES = {"str", "int", "float", "bool", "datetime", "date"}
LIST_TYPES = {"list[str]", "list[int]", "list[float]", "list[bool]"}
ELEMENT_TYPE_MAP: dict[str, Any] = {
    "list[str]": str,
    "list[int]": int,
    "list[float]": float,
    "list[bool]": bool,
}


@dataclass
class ValidationDef:
    min: float | None = None
    max: float | None = None
    pattern: str | None = None
    required: bool = True


@dataclass
class FieldDef:
    name: str
    cell: str | None = None
    range: str | None = None
    type_str: str | None = None
    orientation: str | None = None
    computed: str | None = None
    columns: dict[str, str] | None = None
    validation: ValidationDef | None = None

    @property
    def resolved_type_str(self) -> str:
        """Return the type string, applying defaults based on cell vs range."""
        if self.type_str is not None:
            return self.type_str
        if self.computed is not None:
            return "any"
        if self.cell is not None:
            return "str"
        if self.range is not None:
            return "list[str]"
        raise StencilError(f"Field '{self.name}' has no cell, range, or computed")

    @property
    def python_type(self) -> Any:
        ts = self.resolved_type_str
        if ts not in TYPE_MAP:
            raise StencilError(f"Unknown type '{ts}' for field '{self.name}'")
        return TYPE_MAP[ts]

    @property
    def is_computed(self) -> bool:
        return self.computed is not None

    @property
    def is_table(self) -> bool:
        return self.resolved_type_str == "table"

    @property
    def is_dict(self) -> bool:
        return self.resolved_type_str == "dict[str, str]"

    @property
    def is_list(self) -> bool:
        return self.resolved_type_str in LIST_TYPES

    @property
    def is_scalar(self) -> bool:
        return self.resolved_type_str in SCALAR_TYPES

    @property
    def element_type(self) -> Any:
        ts = self.resolved_type_str
        return ELEMENT_TYPE_MAP.get(ts)

    @property
    def table_orientation(self) -> str:
        if self.orientation and self.orientation.lower() in {"vertical", "horizontal"}:
            return self.orientation.lower()
        return "horizontal"


@dataclass
class VersionDef:
    version_key: str
    extends: str | None = None
    fields: dict[str, FieldDef] = field(default_factory=dict)


@dataclass
class StencilSchema:
    name: str
    description: str
    discriminator_cell: str
    discriminator_cells: list[str]
    versions: dict[str, VersionDef]
    source_path: Path | None = None

    @classmethod
    def from_file(cls, path: str | Path) -> StencilSchema:
        path = Path(path)
        if not path.exists():
            raise StencilError(f"Schema file not found: {path}")
        with open(path) as f:
            data = yaml.safe_load(f)
        schema = cls.from_dict(data)
        schema.source_path = path
        return schema

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> StencilSchema:
        if not isinstance(data, dict):
            raise StencilError("Schema must be a YAML mapping")

        name = data.get("name")
        if not name:
            raise StencilError("Schema must have a 'name' field")

        description = data.get("description", "")

        disc = data.get("discriminator")
        if not isinstance(disc, dict):
            raise StencilError("Schema must have a 'discriminator' mapping")

        raw_discriminator_cells = disc.get("cells")
        if raw_discriminator_cells is None and disc.get("cell") is not None:
            raw_discriminator_cells = [disc["cell"]]

        if not isinstance(raw_discriminator_cells, list):
            raise StencilError("Schema discriminator must define 'cells' as a list or legacy 'cell' as a string")

        discriminator_cells = [
            str(cell).strip()
            for cell in raw_discriminator_cells
            if str(cell).strip()
        ]
        if not discriminator_cells:
            raise StencilError("Schema must have a 'discriminator' with at least one cell in 'cells'")

        discriminator_cell = discriminator_cells[0]

        raw_versions = data.get("versions")
        if not raw_versions:
            raise StencilError("Schema must have at least one version")

        versions: dict[str, VersionDef] = {}
        for ver_key, ver_data in raw_versions.items():
            ver_key = str(ver_key)
            versions[ver_key] = _parse_version(ver_key, ver_data)

        _resolve_inheritance(versions)

        return cls(
            name=name,
            description=description,
            discriminator_cell=discriminator_cell,
            discriminator_cells=discriminator_cells,
            versions=versions,
        )


def _resolve_inheritance(versions: dict[str, VersionDef]) -> None:
    """Resolve extends chains, merging parent fields into child versions in-place."""
    resolved: set[str] = set()
    resolving: set[str] = set()

    def resolve(ver_key: str) -> None:
        if ver_key in resolved:
            return
        if ver_key in resolving:
            raise StencilError(f"Circular extends detected involving version '{ver_key}'")

        version = versions[ver_key]
        if version.extends is None:
            resolved.add(ver_key)
            return

        parent_key = version.extends
        if parent_key not in versions:
            raise StencilError(
                f"Version '{ver_key}' extends unknown version '{parent_key}'"
            )

        resolving.add(ver_key)
        resolve(parent_key)
        resolving.discard(ver_key)

        parent = versions[parent_key]
        merged_fields: dict[str, FieldDef] = {}
        merged_fields.update(parent.fields)
        merged_fields.update(version.fields)
        version.fields = merged_fields
        resolved.add(ver_key)

    for ver_key in versions:
        resolve(ver_key)


def _parse_version(ver_key: str, ver_data: dict[str, Any]) -> VersionDef:
    if not isinstance(ver_data, dict):
        raise StencilError(f"Version '{ver_key}' must be a mapping")

    raw_fields = ver_data.get("fields", {})
    raw_validation = ver_data.get("validation", {})

    fields: dict[str, FieldDef] = {}
    for fname, fdata in raw_fields.items():
        if not isinstance(fdata, dict):
            raise StencilError(f"Field '{fname}' in version '{ver_key}' must be a mapping")

        val_data = raw_validation.get(fname, {})
        validation = None
        if val_data:
            validation = ValidationDef(
                min=val_data.get("min"),
                max=val_data.get("max"),
                pattern=val_data.get("pattern"),
                required=val_data.get("required", True),
            )

        fields[fname] = FieldDef(
            name=fname,
            cell=fdata.get("cell"),
            range=fdata.get("range"),
            type_str=fdata.get("type"),
            orientation=fdata.get("orientation"),
            computed=fdata.get("computed"),
            columns=fdata.get("columns"),
            validation=validation,
        )

    extends = ver_data.get("extends")
    if extends is not None:
        extends = str(extends)
    return VersionDef(version_key=ver_key, extends=extends, fields=fields)
