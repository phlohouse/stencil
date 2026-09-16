from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
import webbrowser
from urllib.parse import urlparse

from .errors import StencilError
from .ui import BundledUIServer, start_bundled_ui_server

DEFAULT_EDITOR_URL = "http://localhost:5173"
EDITOR_START_TIMEOUT_SECONDS = 15.0
EDITOR_DIR_ENV_VAR = "STENCIL_EDITOR_DIR"


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
    extract_parser.add_argument(
        "--strict",
        action="store_true",
        help="Fail when a value breaks a field's validation rules (min/max/pattern/required)",
    )
    extract_parser.add_argument(
        "--out",
        "-o",
        default=None,
        help="Write the output to a file instead of stdout",
    )
    extract_parser.add_argument(
        "--format",
        "-f",
        choices=("json", "ndjson"),
        default="json",
        help="Output format: json (default) or ndjson, one record per line",
    )

    phlo_parser = subparsers.add_parser(
        "phlo",
        help="Generate Phlo dlt/dbt artifacts from a schema",
    )
    phlo_parser.add_argument(
        "schema",
        help="Path to a .stencil.yaml file, or a directory of schemas",
    )
    phlo_parser.add_argument(
        "--out",
        default=".",
        help="Phlo project root to write into (default: current directory)",
    )
    phlo_parser.add_argument(
        "--table",
        default=None,
        help="Raw table name (default: schema name; single schema only)",
    )
    phlo_parser.add_argument(
        "--domain",
        default=None,
        help="Workflow domain/module name (default: table name; single schema only)",
    )
    phlo_parser.add_argument(
        "--input-dir",
        default=None,
        help="Directory (or workbook) holding the Excel files (default: data/<table>; single schema only)",
    )
    phlo_parser.add_argument(
        "--dialect",
        default="trino",
        choices=sorted(_phlo_dialects()),
        help="SQL engine for the generated dbt models (default: trino)",
    )
    phlo_parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite generated files that already exist",
    )

    validate_parser = subparsers.add_parser(
        "validate",
        help="Check a schema, and optionally which version matches a file",
    )
    validate_parser.add_argument(
        "schema",
        help="Path to a .stencil.yaml file or directory of schemas",
    )
    validate_parser.add_argument(
        "path",
        nargs="?",
        default=None,
        help="Optional Excel file to check against the schema",
    )

    open_parser = subparsers.add_parser(
        "open",
        help="Open the editor web app in your default browser",
    )
    open_parser.add_argument(
        "url",
        nargs="?",
        default=None,
        help="Optional URL to open instead of the packaged/local editor UI",
    )

    args = parser.parse_args(argv)

    if args.command is None:
        parser.print_help()
        return 1

    if args.command == "extract":
        return _run_extract(args)
    if args.command == "phlo":
        return _run_phlo(args)
    if args.command == "validate":
        return _run_validate(args)
    if args.command == "open":
        return _run_open(args)

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
                        model = stencil._extract_with_schema(
                            schema,
                            target_path,
                            version_key=args.version,
                            validate=args.strict,
                        )
                        _emit(model.model_dump(), args, indent)
                        return 0
                print(f"Error: version '{args.version}' not found in schema", file=sys.stderr)
                return 1
            else:
                model = stencil.extract(target_path, validate=args.strict)
                _emit(model.model_dump(), args, indent)
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
            validate=args.strict,
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

    _emit(output, args, indent)
    return 1 if results.has_failures else 0


def _emit(payload: object, args: argparse.Namespace, indent: int | None) -> None:
    """Write the extraction result to stdout or to ``--out``."""
    if args.format == "ndjson":
        records = payload if isinstance(payload, list) else [payload]
        text = "\n".join(json.dumps(record, default=str) for record in records)
    else:
        text = json.dumps(payload, indent=indent, default=str)

    out_path = getattr(args, "out", None)
    if not out_path:
        print(text)
        return

    path = Path(out_path)
    if path.parent != Path(""):
        path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text + "\n")
    print(f"Wrote {path}")


def _run_validate(args: argparse.Namespace) -> int:
    from . import Stencil
    from .extractor import extract_fields
    from .validation import collect_violations, is_empty
    from .versioning import resolve_version

    schema_path = Path(args.schema)
    try:
        stencil = Stencil(schema_path)
    except StencilError as e:
        print(f"Error loading schema: {e}", file=sys.stderr)
        return 1

    target_path = Path(args.path) if args.path else None
    if target_path is not None and not target_path.is_file():
        print(f"Error: '{target_path}' is not a file", file=sys.stderr)
        return 1

    exit_code = 0
    for schema in stencil._schemas:
        print(f"{schema.name}")
        if schema.description:
            print(f"  description: {schema.description}")
        if schema.discriminator_cells:
            print(f"  discriminator cells: {', '.join(schema.discriminator_cells)}")
        else:
            print("  discriminator cells: none, the version is inferred from the layout")

        for key, version in schema.versions.items():
            field_count = len(version.fields)
            computed = sum(1 for field in version.fields.values() if field.is_computed)
            suffix = f" ({computed} computed)" if computed else ""
            print(f"  version {key}: {field_count} field{'s' if field_count != 1 else ''}{suffix}")

            for name, field in version.fields.items():
                if not field.is_computed and field.cell is None and field.range is None:
                    print(f"    {name}: no cell, range or computed expression", file=sys.stderr)
                    exit_code = 1
                    continue
                try:
                    field.python_type
                except StencilError as e:
                    print(f"    {name}: {e}", file=sys.stderr)
                    exit_code = 1

        if target_path is None:
            continue

        try:
            resolved = resolve_version(schema, target_path)
        except StencilError as e:
            print(f"  {target_path.name}: no version matched ({e})", file=sys.stderr)
            exit_code = 1
            continue

        matched_by = (
            f"discriminator cell {resolved.matched_cell}"
            if resolved.matched_by == "discriminator"
            else "layout inference"
        )
        print(f"  {target_path.name}: matches {resolved.version_key} by {matched_by}")
        if resolved.checked_cells:
            checked = ", ".join(f"{item.cell}={item.value!r}" for item in resolved.checked_cells)
            print(f"    checked: {checked}")

        version = schema.versions[resolved.version_key]
        try:
            values = extract_fields(target_path, version.fields)
        except StencilError as e:
            print(f"    extraction failed: {e}", file=sys.stderr)
            exit_code = 1
            continue

        violations = collect_violations(version.fields, values)
        flagged = {violation.field.split("[")[0] for violation in violations}
        empty = [
            name
            for name, value in values.items()
            if is_empty(value) and name not in flagged
        ]
        if empty:
            print(f"    no value in this file: {', '.join(empty)}")

        if violations:
            for violation in violations:
                print(f"    rule broken: {violation}", file=sys.stderr)
            exit_code = 1

    return exit_code


def _phlo_dialects() -> dict[str, object]:
    from .phlo import DIALECTS

    return DIALECTS


def _run_phlo(args: argparse.Namespace) -> int:
    from .phlo import write_phlo_files

    try:
        written = write_phlo_files(
            args.schema,
            args.out,
            table_name=args.table,
            domain=args.domain,
            input_dir=args.input_dir,
            dialect=args.dialect,
            force=args.force,
        )
    except StencilError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1

    root = Path(args.out)
    for path in written:
        print(root / path)
    return 0


def _run_open(args: argparse.Namespace) -> int:
    if args.url is not None:
        return _open_url(args.url)

    bundled_server = _start_packaged_ui()
    if bundled_server is not None:
        return _open_started_ui(bundled_server)

    started_process: subprocess.Popen[bytes] | None = None

    if not _is_url_listening(DEFAULT_EDITOR_URL):
        started_process, start_error = _start_editor_dev_server()
        if start_error is not None:
            print(f"Error: {start_error}", file=sys.stderr)
            return 1

        if not _wait_for_url(DEFAULT_EDITOR_URL, timeout_seconds=EDITOR_START_TIMEOUT_SECONDS):
            _terminate_process(started_process)
            print(
                f"Error: editor dev server did not start at {DEFAULT_EDITOR_URL} within "
                f"{EDITOR_START_TIMEOUT_SECONDS:.0f} seconds",
                file=sys.stderr,
            )
            return 1

    return _open_url(DEFAULT_EDITOR_URL, started_process=started_process)


def _open_url(url: str, *, started_process: subprocess.Popen[bytes] | None = None) -> int:
    if _open_browser(url):
        print(url)
        if started_process is not None:
            return _wait_for_started_process(started_process)
        return 0

    _terminate_process(started_process)
    print(f"Error: could not open {url}", file=sys.stderr)
    return 1


def _open_browser(url: str) -> bool:
    if _is_wsl():
        for launcher in _wsl_browser_launchers():
            result = subprocess.run(
                launcher + [url],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
            if result.returncode == 0:
                return True
        return False

    if sys.platform.startswith("linux"):
        opener = shutil.which("xdg-open")
        if opener is None:
            return False

        result = subprocess.run(
            [opener, url],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        return result.returncode == 0

    if sys.platform == "darwin":
        result = subprocess.run(
            ["open", url],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        return result.returncode == 0

    if os.name == "nt":
        try:
            os.startfile(url)  # type: ignore[attr-defined]
        except OSError:
            return False
        return True

    return webbrowser.open(url)


def _is_wsl() -> bool:
    return sys.platform.startswith("linux") and "microsoft" in os.uname().release.lower()


def _wsl_browser_launchers() -> list[list[str]]:
    launchers: list[list[str]] = []

    wslview = shutil.which("wslview")
    if wslview is not None:
        launchers.append([wslview])

    powershell = shutil.which("powershell.exe")
    if powershell is not None:
        launchers.append([powershell, "-NoProfile", "-Command", "Start-Process"])

    cmd = shutil.which("cmd.exe")
    if cmd is not None:
        launchers.append([cmd, "/C", "start", ""])

    explorer = shutil.which("explorer.exe")
    if explorer is not None:
        launchers.append([explorer])

    return launchers


def _start_packaged_ui() -> BundledUIServer | None:
    try:
        return start_bundled_ui_server()
    except OSError as exc:
        print(f"Error: could not start bundled editor UI: {exc}", file=sys.stderr)
        return None


def _open_started_ui(server: BundledUIServer) -> int:
    if _open_browser(server.url):
        print(server.url)
        return server.wait()

    server.close()
    print(f"Error: could not open {server.url}", file=sys.stderr)
    return 1


def _is_url_listening(url: str, timeout_seconds: float = 0.5) -> bool:
    from socket import create_connection

    parsed = urlparse(url)
    if not parsed.hostname:
        return False

    port = parsed.port
    if port is None:
        port = 443 if parsed.scheme == "https" else 80

    try:
        with create_connection((parsed.hostname, port), timeout=timeout_seconds):
            return True
    except OSError:
        return False


def _wait_for_url(url: str, timeout_seconds: float) -> bool:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if _is_url_listening(url):
            return True
        time.sleep(0.1)
    return _is_url_listening(url)


def _start_editor_dev_server() -> tuple[subprocess.Popen[bytes] | None, str | None]:
    editor_dir = _find_editor_dir()
    if editor_dir is None:
        return None, "could not find the editor project to start the web app"

    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0

    try:
        process = subprocess.Popen(
            ["npm", "run", "dev"],
            cwd=editor_dir,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=creationflags,
        )
    except OSError as exc:
        return None, f"could not start editor dev server: {exc}"

    return process, None


def _find_editor_dir() -> Path | None:
    env_dir = os.environ.get(EDITOR_DIR_ENV_VAR)
    if env_dir:
        candidate = Path(env_dir).expanduser().resolve() / "package.json"
        if candidate.is_file():
            return candidate.parent

    search_roots = [Path.cwd(), *Path.cwd().parents, *Path(__file__).resolve().parents]
    seen: set[Path] = set()

    for root in search_roots:
        if root in seen:
            continue
        seen.add(root)

        direct_candidate = root / "editor" / "package.json"
        if direct_candidate.is_file():
            return direct_candidate.parent

        sibling_candidate = root / "stencil" / "editor" / "package.json"
        if sibling_candidate.is_file():
            return sibling_candidate.parent

    return None


def _wait_for_started_process(process: subprocess.Popen[bytes]) -> int:
    try:
        process.wait()
    except KeyboardInterrupt:
        _terminate_process(process)
        return 130
    return process.returncode or 0


def _terminate_process(process: subprocess.Popen[bytes] | None) -> None:
    if process is None or process.poll() is not None:
        return

    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def _cli_entry() -> None:
    sys.exit(main())
