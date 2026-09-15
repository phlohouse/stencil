"""Convert stencil schemas into Phlo ingestion and dbt artifacts.

A ``.stencil.yaml`` schema describes how to pull structured data out of Excel
workbooks. This module turns that schema into the files a Phlo project needs to
land and model the same data:

* a dlt ingestion asset that extracts every workbook with ``stencilpy`` and
  lands one raw row per workbook (``workflows/ingestion/<domain>/<table>.py``)
* a Pandera schema validating those raw rows (``workflows/schemas/<domain>.py``)
* dbt models: a typed bronze view plus one silver model per ``list``, ``dict``
  or ``table`` field that explodes the JSON text back into rows
  (``workflows/transforms/dbt/models/``)

Complex values are stored as JSON text in the raw layer because Phlo's dlt
integration normalises nested lists and dicts into child tables, which the raw
Iceberg table cannot represent.
"""

from __future__ import annotations

import keyword
import re
from dataclasses import dataclass
from pathlib import Path

from .errors import StencilError
from .schema import LIST_TYPES, SCALAR_TYPES, FieldDef, StencilSchema

__all__ = [
    "DIALECTS",
    "DuckDbDialect",
    "ExplodedSql",
    "PhloDialect",
    "PhloFile",
    "PhloField",
    "TrinoDialect",
    "build_phlo_files",
    "get_dialect",
    "write_phlo_files",
]

GENERATED_BY = "stencil phlo"
INPUT_DIR_ENV_VAR = "STENCIL_INPUT_DIR"

# Columns the generator adds to every raw row.
KEY_COLUMNS = ("record_id", "source_file", "stencil_version")
RECORD_ID_COLUMN = "record_id"
SOURCE_FILE_COLUMN = "source_file"
VERSION_COLUMN = "stencil_version"

# Columns Phlo appends to every ingested row.
PHLO_METADATA_COLUMNS = ("_phlo_partition_date", "_phlo_ingested_at", "_phlo_run_id")

# Columns the generated silver models add when exploding a collection field.
CHILD_COLUMNS: dict[str, tuple[str, ...]] = {
    "table": ("row_index", "row_json"),
    "dict[str, str]": ("map_key", "map_value"),
}

COLLECTION_TYPES = {"table", "dict[str, str]", *LIST_TYPES}

JSON_TEXT_TYPE = "varchar"

_SAFE_IDENTIFIER = re.compile(r"[a-z_][a-z0-9_]*")
_SIMPLE_JSON_KEY = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")

# DuckDB reserved keywords, from ``duckdb_keywords()`` where the category is
# "reserved". Trino's list lives on ``TrinoDialect`` below.
DUCKDB_RESERVED_WORDS = frozenset(
    """
    all analyse analyze and any array as asc asymmetric both case cast check collate column
    constraint create default deferrable desc describe distinct do else end except false fetch
    for foreign from group having in initially intersect into lambda lateral leading limit not
    null offset on only or order pivot pivot_longer pivot_wider placing primary qualify
    references returning select show some summarize symmetric table then to trailing true union
    unique unpivot using variadic when where window with
    """.split()
)

# Element type of a stencil ``list[T]`` field, shared by the dialects below.
LIST_ELEMENT_TYPES: dict[str, str] = {
    "list[str]": "varchar",
    "list[int]": "bigint",
    "list[float]": "double",
    "list[bool]": "boolean",
}


@dataclass(frozen=True)
class PhloFile:
    """A generated file, addressed relative to the Phlo project root."""

    path: Path
    content: str
    skip_if_exists: bool = False


@dataclass(frozen=True)
class PhloField:
    """A stencil field projected across every schema version."""

    name: str
    column: str
    type_str: str
    kinds: tuple[str, ...]
    versions: tuple[str, ...]
    sources: tuple[str, ...]
    required: bool
    table_columns: tuple[tuple[str, str], ...] = ()

    @property
    def is_collection(self) -> bool:
        return self.type_str in COLLECTION_TYPES

    @property
    def is_computed(self) -> bool:
        return self.type_str not in SCALAR_TYPES and not self.is_collection

    @property
    def json_comment(self) -> str | None:
        if self.is_computed:
            return "computed field, landed as text"
        if self.is_collection:
            return f"JSON text: {' / '.join(self.kinds)}"
        return None

    @property
    def alias(self) -> str | None:
        return None if self.column == self.name else self.column


@dataclass(frozen=True)
class ExplodedSql:
    """Select expressions and join clause that explode one collection field."""

    columns: tuple[str, ...]
    join: str


class PhloDialect:
    """SQL rendering for one query engine.

    Subclass to target another engine: ``column_types``/``element_types`` map stencil
    types onto SQL types, ``identifier`` quotes column names, and ``explode`` renders
    the join that turns a JSON text column back into one row per entry.
    """

    name: str = ""
    column_types: dict[str, str] = {}
    element_types: dict[str, str] = LIST_ELEMENT_TYPES
    reserved_words: frozenset[str] = frozenset()

    def column_type(self, field_def: PhloField) -> str:
        return self.column_types.get(field_def.type_str, JSON_TEXT_TYPE)

    def element_type(self, field_def: PhloField) -> str:
        return self.element_types.get(field_def.type_str, JSON_TEXT_TYPE)

    def identifier(self, name: str) -> str:
        """Quote a column name when the engine would not accept it unquoted."""
        if _SAFE_IDENTIFIER.fullmatch(name) and name not in self.reserved_words:
            return name
        return '"' + name.replace('"', '""') + '"'

    def json_scalar(self, expr: str, key: str) -> str:
        """Extract one key of a JSON object as text."""
        raise NotImplementedError

    def json_text(self, expr: str) -> str:
        """Render a JSON value as its text representation."""
        raise NotImplementedError

    def explode(self, field_def: PhloField, parent_column: str) -> ExplodedSql:
        """Render the join that explodes ``parent_column`` into one row per entry."""
        raise NotImplementedError


class TrinoDialect(PhloDialect):
    """Trino SQL, the engine Phlo's dbt profile targets.

    Reserved keywords: https://trino.io/docs/current/language/reserved.html
    """

    name = "trino"
    column_types = {
        "str": "varchar",
        "int": "bigint",
        "float": "double",
        "bool": "boolean",
        "datetime": "timestamp with time zone",
        "date": "date",
    }
    reserved_words = frozenset(
        """
        alter and as auto between by case cast constraint create cross cube current_catalog
        current_date current_path current_role current_schema current_time current_timestamp
        current_user deallocate delete describe distinct drop else end escape except exists
        extract false for from full group grouping having in inner insert intersect into is join
        json_array json_exists json_object json_query json_table json_value left like listagg
        localtime localtimestamp natural normalize not null on or order outer overlaps prepare
        recursive right rollup select skip table then trim true uescape union unnest using values
        when where with
        """.split()
    )

    def json_scalar(self, expr: str, key: str) -> str:
        path = f"$.{key}" if _SIMPLE_JSON_KEY.fullmatch(key) else f'$["{_escape_json_path(key)}"]'
        return f"json_extract_scalar({expr}, {_sql_literal(path)})"

    def json_text(self, expr: str) -> str:
        return f"json_format({expr})"

    def explode(self, field_def: PhloField, parent_column: str) -> ExplodedSql:
        child_columns = _child_columns(field_def.type_str)
        if field_def.type_str == "table":
            return ExplodedSql(
                columns=_table_entry_columns(self, field_def, child_columns),
                join=(
                    "cross join unnest(\n"
                    f"    cast(json_parse(coalesce(parent.{parent_column}, '[]')) as array(json))\n"
                    f") with ordinality as entry (payload, {child_columns[0]})"
                ),
            )
        if field_def.type_str == "dict[str, str]":
            return ExplodedSql(
                columns=tuple(f"entry.{column}" for column in child_columns),
                join=(
                    "cross join unnest(\n"
                    f"    cast(json_parse(coalesce(parent.{parent_column}, '{{}}'))"
                    " as map(varchar, varchar))\n"
                    f") as entry ({', '.join(child_columns)})"
                ),
            )
        return ExplodedSql(
            columns=(f"entry.{child_columns[0]}", f"entry.{child_columns[1]}"),
            join=(
                "cross join unnest(\n"
                f"    cast(json_parse(coalesce(parent.{parent_column}, '[]'))"
                f" as array({self.element_type(field_def)}))\n"
                f") with ordinality as entry ({child_columns[1]}, {child_columns[0]})"
            ),
        )


class DuckDbDialect(PhloDialect):
    """DuckDB SQL, for local analysis with dbt-duckdb or the DuckDB CLI.

    Reserved keywords come from ``duckdb_keywords()`` where the category is
    "reserved".
    """

    name = "duckdb"
    column_types = {
        "str": "varchar",
        "int": "bigint",
        "float": "double",
        "bool": "boolean",
        "datetime": "timestamptz",
        "date": "date",
    }
    reserved_words = DUCKDB_RESERVED_WORDS

    def json_scalar(self, expr: str, key: str) -> str:
        path = f"$.{key}" if _SIMPLE_JSON_KEY.fullmatch(key) else f'$."{_escape_json_path(key)}"'
        return f"json_extract_string({expr}, {_sql_literal(path)})"

    def json_text(self, expr: str) -> str:
        return f"cast({expr} as varchar)"

    def explode(self, field_def: PhloField, parent_column: str) -> ExplodedSql:
        child_columns = _child_columns(field_def.type_str)
        if field_def.type_str == "table":
            return ExplodedSql(
                columns=_table_entry_columns(self, field_def, child_columns),
                join=(
                    "cross join unnest(\n"
                    f"    cast(json(coalesce(parent.{parent_column}, '[]')) as json[])\n"
                    f") with ordinality as entry (payload, {child_columns[0]})"
                ),
            )
        if field_def.type_str == "dict[str, str]":
            # json_each yields (key, value, type, ...) and its values are JSON,
            # so the value column is unwrapped back to text.
            return ExplodedSql(
                columns=(
                    f"entry.{child_columns[0]}",
                    f"json_extract_string(entry.{child_columns[1]}, '$')"
                    f" as {child_columns[1]}",
                ),
                join=(
                    f"cross join json_each(coalesce(parent.{parent_column}, '{{}}'))"
                    f" as entry ({child_columns[0]}, {child_columns[1]}, map_type)"
                ),
            )
        return ExplodedSql(
            columns=(f"entry.{child_columns[0]}", f"entry.{child_columns[1]}"),
            join=(
                "cross join unnest(\n"
                f"    cast(json(coalesce(parent.{parent_column}, '[]'))"
                f" as {self.element_type(field_def)}[])\n"
                f") with ordinality as entry ({child_columns[1]}, {child_columns[0]})"
            ),
        )


DIALECTS: dict[str, PhloDialect] = {"trino": TrinoDialect(), "duckdb": DuckDbDialect()}


def get_dialect(dialect: str | PhloDialect) -> PhloDialect:
    """Resolve a dialect name, or pass a ``PhloDialect`` instance through."""
    if isinstance(dialect, PhloDialect):
        return dialect
    try:
        return DIALECTS[dialect]
    except KeyError:
        supported = ", ".join(sorted(DIALECTS))
        raise StencilError(f"Unknown dialect '{dialect}' (supported: {supported})") from None


def build_phlo_files(
    schema: StencilSchema,
    *,
    table_name: str | None = None,
    domain: str | None = None,
    input_dir: str | None = None,
    dialect: str | PhloDialect = "trino",
) -> list[PhloFile]:
    """Build the Phlo files for ``schema`` without touching the filesystem.

    ``table_name`` defaults to the schema name, ``domain`` to the table name and
    ``input_dir`` to ``data/<table>``. ``dialect`` selects the SQL engine for the
    generated dbt models. Returned paths are relative to the Phlo project root.
    The schema must have been loaded from a file so it can be copied into the
    project and referenced by the generated asset.
    """
    if schema.source_path is None:
        raise StencilError("Schema must be loaded from a file before generating Phlo files")
    engine = get_dialect(dialect)

    table = _snake_case(table_name or schema.name)
    domain_name = _snake_case(domain or table)
    if not table or not domain_name:
        raise StencilError("Schema name must contain at least one letter or digit")
    if keyword.iskeyword(table) or table in engine.reserved_words:
        raise StencilError(
            f"Table name '{table}' is a reserved word; pass --table with a different name"
        )
    if keyword.iskeyword(domain_name):
        raise StencilError(
            f"Domain name '{domain_name}' is a reserved word; pass --domain with a different name"
        )

    fields = _project_fields(schema)
    schema_file_name = schema.source_path.name
    input_path = input_dir or f"data/{table}"

    dbt_models = Path("workflows") / "transforms" / "dbt" / "models"
    ingestion_dir = Path("workflows") / "ingestion" / domain_name
    schema_dir = Path("workflows") / "schemas"

    files = [
        PhloFile(
            ingestion_dir / "__init__.py",
            f'"""Domain: {domain_name}"""\n',
            skip_if_exists=True,
        ),
        PhloFile(schema_dir / f"{domain_name}.py", _render_pandera_schema(schema, fields, table)),
        PhloFile(
            ingestion_dir / f"{table}.py",
            _render_ingestion_asset(schema, fields, table, domain_name, schema_file_name, input_path),
        ),
        PhloFile(ingestion_dir / schema_file_name, schema.source_path.read_text()),
        PhloFile(dbt_models / "sources.yml", _render_sources_yml(schema, table)),
        PhloFile(dbt_models / "schema.yml", _render_model_schema_yml(schema, fields, table)),
        PhloFile(
            dbt_models / "bronze" / f"stg_{table}.sql",
            _render_bronze_model(schema, fields, table, engine),
        ),
    ]
    files.extend(
        PhloFile(
            dbt_models / "silver" / f"fct_{table}_{field.column}.sql",
            _render_silver_model(field, table, engine),
        )
        for field in fields
        if field.is_collection
    )
    files.append(
        PhloFile(
            Path("STENCIL.md"),
            _render_readme(schema, fields, table, domain_name, input_path, engine),
        )
    )
    return files


def write_phlo_files(
    schema_path: str | Path,
    out_dir: str | Path = ".",
    *,
    table_name: str | None = None,
    domain: str | None = None,
    input_dir: str | None = None,
    dialect: str | PhloDialect = "trino",
    force: bool = False,
) -> list[Path]:
    """Write the Phlo files for ``schema_path`` into ``out_dir``.

    ``out_dir`` is the Phlo project root and ``dialect`` the SQL engine of the
    generated dbt models. Existing files raise ``StencilError`` unless ``force``
    is set; ``__init__.py`` files are only created when missing. Returns the
    written paths, relative to the project root.
    """
    schema = StencilSchema.from_file(schema_path)
    files = build_phlo_files(
        schema,
        table_name=table_name,
        domain=domain,
        input_dir=input_dir,
        dialect=dialect,
    )
    root = Path(out_dir)

    conflicts = [
        file.path for file in files if not file.skip_if_exists and (root / file.path).exists()
    ]
    if conflicts and not force:
        listed = "\n".join(f"  - {path}" for path in conflicts)
        raise StencilError(
            f"Refusing to overwrite existing files:\n{listed}\n"
            "Re-run with --force to overwrite them."
        )

    written: list[Path] = []
    for file in files:
        target = root / file.path
        if file.skip_if_exists and target.exists():
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(file.content)
        written.append(file.path)
    return written


def _project_fields(schema: StencilSchema) -> list[PhloField]:
    """Project every version's fields onto one column set for the raw table."""
    order: list[str] = []
    entries: dict[str, list[tuple[str, FieldDef]]] = {}
    for version_key, version in schema.versions.items():
        for name, field_def in version.fields.items():
            if name not in entries:
                order.append(name)
                entries[name] = []
            entries[name].append((version_key, field_def))

    fields: list[PhloField] = []
    columns = _assign_columns(order, set(KEY_COLUMNS) | set(PHLO_METADATA_COLUMNS))
    for name, column in zip(order, columns):
        versions = entries[name]
        kinds = tuple(dict.fromkeys(field_def.resolved_type_str for _, field_def in versions))
        type_str = _union_type(kinds)
        fields.append(
            PhloField(
                name=name,
                column=column,
                type_str=type_str,
                kinds=kinds,
                versions=tuple(version_key for version_key, _ in versions),
                sources=tuple(
                    f"{version_key} {_describe_source(field_def)}"
                    for version_key, field_def in versions
                ),
                required=(
                    len(versions) == len(schema.versions)
                    and all(
                        field_def.validation is not None and field_def.validation.required
                        for _, field_def in versions
                    )
                ),
                table_columns=_table_columns(versions, type_str),
            )
        )
    return fields


def _union_type(kinds: tuple[str, ...]) -> str:
    """Collapse per-version types into the single type of the raw column."""
    if len(kinds) == 1:
        return kinds[0]
    if all(kind in LIST_TYPES for kind in kinds):
        return "list[str]"
    if all(kind in COLLECTION_TYPES for kind in kinds):
        for candidate in ("table", "dict[str, str]", "list[str]"):
            if candidate in kinds:
                return candidate
    # Mixed scalars (or scalar/complex mixes) land as text.
    return "str"


def _table_columns(
    versions: list[tuple[str, FieldDef]],
    type_str: str,
) -> tuple[tuple[str, str], ...]:
    """Ordered (json key, column name) pairs for ``table`` fields with a column map."""
    if type_str != "table":
        return ()
    keys: list[str] = []
    seen: set[str] = set()
    for _, field_def in versions:
        for key in (field_def.columns or {}).values():
            key = str(key)
            if key not in seen:
                seen.add(key)
                keys.append(key)
    reserved = set(KEY_COLUMNS) | set(PHLO_METADATA_COLUMNS) | set(_child_columns(type_str))
    return tuple(zip(keys, _assign_columns(keys, reserved)))


def _describe_source(field_def: FieldDef) -> str:
    if field_def.computed is not None:
        return "computed"
    if field_def.cell is not None:
        return f"cell {field_def.cell}"
    if field_def.range is not None:
        return f"range {field_def.range}"
    return "unmapped"


def _column_name(name: str) -> str:
    """Normalise a stencil field name into a SQL/Python column name."""
    column = _snake_case(name) or "field"
    if keyword.iskeyword(column) or column in KEY_COLUMNS or column in PHLO_METADATA_COLUMNS:
        column = f"field_{column}"
    return column


def _child_columns(type_str: str) -> tuple[str, ...]:
    """Columns a silver model adds alongside the parent key columns."""
    if type_str in CHILD_COLUMNS:
        return CHILD_COLUMNS[type_str]
    return ("list_index", "value")


def _table_entry_columns(
    dialect: "PhloDialect",
    field_def: PhloField,
    child_columns: tuple[str, ...],
) -> tuple[str, ...]:
    """Select expressions for the entries of an exploded ``table`` field."""
    columns = [f"entry.{child_columns[0]}"]
    columns.extend(
        f"{dialect.json_scalar('entry.payload', key)} as {dialect.identifier(column)}"
        for key, column in field_def.table_columns
    )
    if not field_def.table_columns:
        columns.append(
            f"{dialect.json_text('entry.payload')} as {child_columns[1]}"
            "  -- add columns here once the sheet headers are known"
        )
    return tuple(columns)


def _escape_json_path(key: str) -> str:
    return key.replace("\\", "\\\\").replace('"', '\\"')


def _sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _assign_columns(names: list[str], reserved: set[str]) -> list[str]:
    """Map names to unique column names, suffixing duplicates."""
    used = set(reserved)
    columns: list[str] = []
    for name in names:
        column = _column_name(name)
        if column in used:
            index = 2
            while f"{column}_{index}" in used:
                index += 1
            column = f"{column}_{index}"
        used.add(column)
        columns.append(column)
    return columns


def _snake_case(name: str) -> str:
    name = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", str(name))
    return re.sub(r"[^0-9a-zA-Z]+", "_", name).strip("_").lower()


def _pascal_case(name: str) -> str:
    parts = re.split(r"[^0-9a-zA-Z]+", name)
    return "".join(part[:1].upper() + part[1:] for part in parts if part)


def _pandera_class_name(table: str) -> str:
    return f"Raw{_pascal_case(table)}"


def _render_pandera_schema(schema: StencilSchema, fields: list[PhloField], table: str) -> str:
    class_name = _pandera_class_name(table)
    versions = ", ".join(schema.versions)
    lines = [
        f'"""Pandera schema for raw ``{table}`` rows extracted from {schema.name} workbooks.',
        "",
        f"{GENERATED_BY}: regenerate instead of editing.",
        "",
        "Complex values (lists, tables, key/value maps) and computed fields land as text",
        "columns: Phlo's dlt integration normalises nested values into child tables, which",
        "the raw Iceberg table cannot represent.",
        '"""',
        "",
        "from __future__ import annotations",
        "",
    ]

    type_imports = sorted(
        {field.type_str for field in fields if field.type_str in {"datetime", "date"}}
    )
    if type_imports:
        lines.append(f"from datetime import {', '.join(type_imports)}")
        lines.append("")

    lines.extend(
        [
            "import pandera.pandas as pa",
            "",
            "",
            f"class {class_name}(pa.DataFrameModel):",
            f'    """Raw ``{table}`` extractions ({versions})."""',
            "",
            "    class Config:",
            "        # Matches the defaults of phlo_pandera.schemas.PhloSchema.",
            "        strict = False",
            "        coerce = True",
            "",
            f"    {RECORD_ID_COLUMN}: str = pa.Field(unique=True)",
            f"    {SOURCE_FILE_COLUMN}: str",
            f"    {VERSION_COLUMN}: str",
        ]
    )
    for field_def in fields:
        lines.append(
            f"    {field_def.column}: {_pandera_type(field_def)} | None = pa.Field(nullable=True)"
            f"  # {_describe_field(field_def)}"
        )

    lines.append("")
    return "\n".join(lines)


def _pandera_type(field_def: PhloField) -> str:
    if field_def.type_str in SCALAR_TYPES:
        return field_def.type_str
    return "str"


def _describe_field(field_def: PhloField) -> str:
    kind = "computed" if field_def.is_computed else field_def.type_str
    return f"{kind} ({', '.join(field_def.sources)})"


def _render_ingestion_asset(
    schema: StencilSchema,
    fields: list[PhloField],
    table: str,
    domain: str,
    schema_file_name: str,
    input_path: str,
) -> str:
    class_name = _pandera_class_name(table)
    json_fields = [field_def.name for field_def in fields if field_def.is_collection]
    text_fields = [field_def.name for field_def in fields if field_def.is_computed]
    aliases = {
        field_def.name: field_def.column for field_def in fields if field_def.alias is not None
    }

    lines = [
        f'"""Ingest {schema.name} workbooks into raw.{table}.',
        "",
        f"Extracts every Excel workbook found in {INPUT_DIR_ENV_VAR} (default: {input_path}) with",
        "the stencil schema bundled next to this file and lands one row per workbook.",
        "",
        f"{GENERATED_BY}: regenerate instead of editing.",
        '"""',
        "",
        "from __future__ import annotations",
        "",
        "import json",
        "import os",
        "from pathlib import Path",
        "",
        "import dlt",
        "import phlo",
        "",
        "from stencilpy import Stencil, StencilError",
        "from stencilpy.schema import StencilSchema",
        "from stencilpy.versioning import resolve_version",
        "",
        f"from workflows.schemas.{domain} import {class_name}",
        "",
        f'SCHEMA_PATH = Path(__file__).with_name("{schema_file_name}")',
        f'INPUT_DIR = Path(os.environ.get("{INPUT_DIR_ENV_VAR}", "{input_path}"))',
        "",
        'EXCEL_SUFFIXES = {".xlsx", ".xlsm", ".xlsb", ".xls"}',
        "",
        "# Fields landed as JSON text (stencil list/dict/table types).",
        f"JSON_FIELDS = {_set_literal(json_fields)}",
        "",
        "# Computed fields have no declared type; they land as text.",
        f"TEXT_FIELDS = {_set_literal(text_fields)}",
        "",
        "# Stencil field names normalised into SQL/Python column names.",
        f"FIELD_ALIASES = {_dict_literal(aliases)}",
        "",
        "",
        "def _json(value: object) -> object:",
        '    """JSON-encode nested values so dlt keeps them in the parent table."""',
        "    if isinstance(value, (list, dict)):",
        "        return json.dumps(value, default=str)",
        "    return value",
        "",
        "",
        "def _text(value: object) -> object:",
        '    """Land computed values as text without quoting plain strings."""',
        "    if value is None or isinstance(value, str):",
        "        return value",
        "    if isinstance(value, (list, dict)):",
        "        return json.dumps(value, default=str)",
        "    return str(value)",
        "",
        "",
        "def _workbooks(input_path: Path) -> list[Path]:",
        "    if input_path.is_file():",
        "        return [input_path]",
        "    return sorted(",
        "        path",
        '        for path in input_path.rglob("*")',
        '        if path.suffix.lower() in EXCEL_SUFFIXES and not path.name.startswith("~$")',
        "    )",
        "",
        "",
        "def _rows(partition_date: str) -> list[dict[str, object]]:",
        "    workbooks = _workbooks(INPUT_DIR)",
        "    if not workbooks:",
        '        raise RuntimeError(f"No Excel workbooks found in {INPUT_DIR}")',
        "",
        "    stencil = Stencil(SCHEMA_PATH)",
        "    schema = StencilSchema.from_file(SCHEMA_PATH)",
        "    rows: list[dict[str, object]] = []",
        "",
        "    for workbook in workbooks:",
        "        source_file = (",
        "            workbook.relative_to(INPUT_DIR).as_posix()",
        "            if INPUT_DIR.is_dir()",
        "            else workbook.name",
        "        )",
        "        try:",
        "            record = stencil.extract(workbook)",
        "        except StencilError as exc:",
        '            raise RuntimeError(f"Failed to extract {source_file}: {exc}") from exc',
        "",
        "        row: dict[str, object] = {",
        '            "record_id": f"{partition_date}:{source_file}",',
        '            "source_file": source_file,',
        '            "stencil_version": resolve_version(schema, workbook).version_key,',
        "        }",
        "        for name, value in record.model_dump().items():",
        "            column = FIELD_ALIASES.get(name, name)",
        "            if name in JSON_FIELDS:",
        "                row[column] = _json(value)",
        "            elif name in TEXT_FIELDS:",
        "                row[column] = _text(value)",
        "            else:",
        "                row[column] = value",
        "        rows.append(row)",
        "",
        "    return rows",
        "",
        "",
        "@phlo.ingest.dlt(",
        f'    table_name="{table}",',
        f'    unique_key="{RECORD_ID_COLUMN}",',
        f"    validation_schema={class_name},",
        f'    group="{domain}",',
        "    freshness_hours=(24, 48),",
        ")",
        f"def {table}(partition_date: str) -> object:",
        f'    """Land every workbook in {INPUT_DIR_ENV_VAR} as one raw row per partition."""',
        f'    return dlt.resource(_rows(partition_date), name="{table}")',
        "",
    ]
    return "\n".join(lines)


def _set_literal(values: list[str]) -> str:
    if not values:
        return "set()"
    if len(values) == 1:
        return f'{{"{values[0]}"}}'
    items = "".join(f'\n    "{value}",' for value in values)
    return f"{{{items}\n}}"


def _dict_literal(mapping: dict[str, str]) -> str:
    if not mapping:
        return "{}"
    items = "".join(f'\n    "{key}": "{value}",' for key, value in mapping.items())
    return f"{{{items}\n}}"


def _render_sources_yml(schema: StencilSchema, table: str) -> str:
    return "\n".join(
        [
            "version: 2",
            "",
            "sources:",
            f"  - name: {table}_raw",
            f"    description: Raw {schema.name} workbook extractions landed by the stencil asset.",
            "    schema: raw",
            "    tables:",
            f"      - name: {table}",
            f"        identifier: {table}",
            "        description: One row per extracted workbook, all schema versions.",
            "        meta:",
            f"          phlo_asset_key: dlt_{table}",
            "",
        ]
    )


def _render_bronze_model(
    schema: StencilSchema,
    fields: list[PhloField],
    table: str,
    dialect: PhloDialect,
) -> str:
    columns = [
        f"{dialect.identifier(RECORD_ID_COLUMN)},",
        f"{dialect.identifier(SOURCE_FILE_COLUMN)},",
        f"{dialect.identifier(VERSION_COLUMN)},",
    ]
    for field_def in fields:
        column = dialect.identifier(field_def.column)
        sql_type = dialect.column_type(field_def)
        if sql_type != JSON_TEXT_TYPE:
            column = f"cast({column} as {sql_type}) as {column}"
        comment = f"  -- {field_def.json_comment}" if field_def.json_comment else ""
        columns.append(f"{column},{comment}")
    body_lines = [f"    {column}" for column in columns]
    body_lines.extend(
        [
            "",
            "    -- Phlo ingestion metadata",
            f"    {PHLO_METADATA_COLUMNS[0]},",
            f"    {PHLO_METADATA_COLUMNS[1]},",
            f"    {PHLO_METADATA_COLUMNS[2]}",
        ]
    )
    body = "\n".join(body_lines)

    return "\n".join(
        [
            f"-- Bronze staging model for raw {table} extractions ({', '.join(schema.versions)}).",
            f"-- {GENERATED_BY} ({dialect.name}): regenerate instead of editing.",
            "",
            "{{ config(",
            "    materialized='view',",
            f"    tags=['stencil', '{table}', 'bronze'],",
            ") }}",
            "",
            "select",
            body,
            f"from {{{{ source('{table}_raw', '{table}') }}}}",
            "",
        ]
    )


def _render_silver_model(field_def: PhloField, table: str, dialect: PhloDialect) -> str:
    exploded = dialect.explode(field_def, dialect.identifier(field_def.column))
    columns = [
        f"parent.{dialect.identifier(RECORD_ID_COLUMN)}",
        f"parent.{dialect.identifier(SOURCE_FILE_COLUMN)}",
        f"parent.{dialect.identifier(VERSION_COLUMN)}",
        f"parent.{dialect.identifier(PHLO_METADATA_COLUMNS[0])}",
        *exploded.columns,
    ]

    return "\n".join(
        [
            f"-- Silver model exploding {table}.{field_def.column}"
            f" ({' / '.join(field_def.kinds)}) into one row per entry.",
            f"-- Versions: {', '.join(field_def.versions)}.",
            f"-- {GENERATED_BY} ({dialect.name}): regenerate instead of editing.",
            "",
            "{{ config(",
            "    materialized='table',",
            f"    tags=['stencil', '{table}', 'silver'],",
            ") }}",
            "",
            "select",
            ",\n".join(f"    {column}" for column in columns),
            f"from {{{{ ref('stg_{table}') }}}} as parent",
            exploded.join,
            "",
        ]
    )


def _render_model_schema_yml(schema: StencilSchema, fields: list[PhloField], table: str) -> str:
    lines = [
        "version: 2",
        "",
        "models:",
        f"  - name: stg_{table}",
        f"    description: Typed view of raw {schema.name} extractions, one row per workbook.",
        "    columns:",
        f"      - name: {RECORD_ID_COLUMN}",
        "        description: Stable id for the workbook (<partition date>:<relative path>).",
        "        tests: [unique, not_null]",
        f"      - name: {SOURCE_FILE_COLUMN}",
        "        description: Workbook path relative to the stencil input directory.",
        f"      - name: {VERSION_COLUMN}",
        "        description: Stencil schema version detected for the workbook.",
    ]
    for field_def in fields:
        lines.append(f"      - name: {field_def.column}")
        lines.append(f"        description: {_describe_field(field_def)}.")
        if field_def.required:
            lines.append("        tests: [not_null]")

    for field_def in fields:
        if not field_def.is_collection:
            continue
        lines.extend(
            [
                f"  - name: fct_{table}_{field_def.column}",
                f"    description: One row per {field_def.column} entry"
                f" ({' / '.join(field_def.kinds)}).",
                "    columns:",
                f"      - name: {RECORD_ID_COLUMN}",
                "        tests: [not_null]",
            ]
        )
        if field_def.type_str == "table":
            lines.append("      - name: row_index")
            lines.append("        description: 1-based position of the entry in the range.")
            lines.append("        tests: [not_null]")
            for key, column in field_def.table_columns:
                lines.append(f"      - name: {column}")
                lines.append(f"        description: Sheet column '{key}', landed as text.")
        elif field_def.type_str == "dict[str, str]":
            lines.append("      - name: map_key")
            lines.append("        tests: [not_null]")
            lines.append("      - name: map_value")
        else:
            lines.append("      - name: list_index")
            lines.append("        description: 1-based position of the value in the range.")
            lines.append("        tests: [not_null]")
            lines.append("      - name: value")

    lines.append("")
    return "\n".join(lines)


def _render_readme(
    schema: StencilSchema,
    fields: list[PhloField],
    table: str,
    domain: str,
    input_path: str,
    dialect: PhloDialect,
) -> str:
    class_name = _pandera_class_name(table)
    source_name = schema.source_path.name if schema.source_path else "schema"
    lines = [
        f"# Stencil → Phlo artifacts for `{schema.name}`",
        "",
        f"Generated by `{GENERATED_BY}` from `{source_name}` for the `{dialect.name}` engine.",
        "",
        "## Generated files",
        "",
        "| Path | Purpose |",
        "| --- | --- |",
        f"| `workflows/schemas/{domain}.py` | Pandera schema `{class_name}` validating raw rows |",
        f"| `workflows/ingestion/{domain}/{table}.py` | dlt asset `dlt_{table}` |",
        f"| `workflows/ingestion/{domain}/{source_name}` | Stencil schema used at runtime |",
        "| `workflows/transforms/dbt/models/sources.yml` | dbt source for the raw table |",
        f"| `workflows/transforms/dbt/models/bronze/stg_{table}.sql`"
        " | Typed view, one row per workbook |",
    ]
    for field_def in fields:
        if field_def.is_collection:
            lines.append(
                f"| `workflows/transforms/dbt/models/silver/fct_{table}_{field_def.column}.sql`"
                f" | One row per {field_def.column} entry |"
            )
    lines.extend(
        [
            "| `workflows/transforms/dbt/models/schema.yml` | dbt tests and column docs |",
            "",
            "## Next steps",
            "",
            "1. Add `stencilpy`, `phlo-dlt`, `phlo-pandera` and `openpyxl` to the project dependencies.",
            f"2. Put the workbooks in `{input_path}` (or set `{INPUT_DIR_ENV_VAR}`).",
            f"3. Materialize the raw table: `phlo materialize dlt_{table} --partition 2026-01-15`",
            "4. Run the dbt models: `phlo dbt run`",
            "",
            "## Notes",
            "",
            f"- One raw row per workbook, keyed by `{RECORD_ID_COLUMN}`"
            " (`<partition date>:<relative path>`), so re-running a partition is idempotent.",
            "- `list`, `dict` and `table` fields land as JSON text because Phlo's dlt integration",
            "  normalises nested values into child tables that the raw table cannot represent.",
            "  The generated silver models explode them back into one row per entry.",
            "- Workbooks matching no schema version fail the run with a `VersionError`.",
            f"- The dbt models target `{dialect.name}`; regenerate with `{GENERATED_BY} --dialect` to",
            "  produce models for another engine (Phlo's own dbt profile targets Trino).",
            f"- Regenerate with `{GENERATED_BY} {source_name} --force` after editing the schema.",
            "",
        ]
    )
    return "\n".join(lines)
