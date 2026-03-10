from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .errors import StencilError


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="stencil",
        description="Extract structured data from Excel files using YAML schemas.",
    )
    subparsers = parser.add_subparsers(dest="command")

    extract_parser = subparsers.add_parser(
        "extract",
        help="Extract data from Excel files",
    )
    extract_parser.add_argument("schema", help="Path to .stencil.yaml file or directory of schemas")
    extract_parser.add_argument("path", help="Path to Excel file or directory of Excel files")
    extract_parser.add_argument("--pretty", "-p", action="store_true", help="Pretty-print JSON output")
    extract_parser.add_argument("--version", "-v", dest="version", default=None, help="Force a specific schema version")
    extract_parser.add_argument("--include", "-i", default=None, help="Glob pattern to filter files in batch mode")
    extract_parser.add_argument("--no-progress", action="store_true", help="Suppress progress bar")

    args = parser.parse_args(argv)

    if args.command is None:
        parser.print_help()
        return 1

    if args.command == "extract":
        return _run_extract(args)

    return 0


def _run_extract(args: argparse.Namespace) -> int:
    from . import Stencil

    schema_path = Path(args.schema)
    target_path = Path(args.path)
    indent = 2 if args.pretty else None

    try:
        stencil = Stencil(schema_path)
    except StencilError as e:
        print(f"Error loading schema: {e}", file=sys.stderr)
        return 1

    # Single file extraction
    if target_path.is_file():
        try:
            if args.version:
                # Force version — extract with specific schema
                for schema in stencil._schemas:
                    if args.version in schema.versions:
                        model = stencil._extract_with_schema(schema, target_path, version_key=args.version)
                        print(json.dumps(model.model_dump(), indent=indent, default=str))
                        return 0
                print(f"Error: version '{args.version}' not found in schema", file=sys.stderr)
                return 1
            else:
                model = stencil.extract(target_path)
                print(json.dumps(model.model_dump(), indent=indent, default=str))
                return 0
        except StencilError as e:
            print(f"Error: {e}", file=sys.stderr)
            return 1

    # Batch extraction (directory or glob)
    try:
        results = stencil.extract(
            target_path,
            include=args.include,
            progress=not args.no_progress,
        )
    except StencilError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1

    output = []
    for result in results.results:
        from .batch import ExtractionSuccess, ExtractionFailure
        if isinstance(result, ExtractionSuccess):
            output.append({
                "file": str(result.path),
                "data": result.model.model_dump(),
            })
        elif isinstance(result, ExtractionFailure):
            print(f"Error extracting {result.path}: {result.error}", file=sys.stderr)
            output.append({
                "file": str(result.path),
                "error": str(result.error),
            })

    print(json.dumps(output, indent=indent, default=str))
    return 1 if results.has_failures else 0


def _cli_entry() -> None:
    sys.exit(main())
