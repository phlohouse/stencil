"""Fail when a built wheel does not bundle the editor UI.

The package serves ``stencilpy/ui_dist`` with ``stencil open``, so a wheel
without it silently ships a CLI that cannot open the editor.

Usage: python scripts/check_wheel_ui.py [dist-dir] [--compare-dir editor/dist]
"""

from __future__ import annotations

import sys
import zipfile
from pathlib import Path

UI_INDEX = "stencilpy/ui_dist/index.html"
UI_ASSETS_PREFIX = "stencilpy/ui_dist/assets/"
UI_PREFIX = "stencilpy/ui_dist/"


def _ui_file_bytes(directory: Path, prefix: str = "") -> dict[str, bytes]:
    return {
        f"{prefix}{path.relative_to(directory).as_posix()}": path.read_bytes()
        for path in directory.rglob("*")
        if path.is_file()
    }


def main(argv: list[str]) -> int:
    args = [arg for arg in argv[1:] if not arg.startswith("--")]
    compare_dir = None
    if "--compare-dir" in argv:
        index = argv.index("--compare-dir")
        compare_dir = Path(argv[index + 1]) if index + 1 < len(argv) else None

    if compare_dir is not None and not compare_dir.is_dir():
        print(f"Editor build directory does not exist: {compare_dir}", file=sys.stderr)
        return 1

    expected_ui = (
        _ui_file_bytes(compare_dir, UI_PREFIX) if compare_dir is not None else None
    )

    dist_dir = Path(args[0]) if args else Path("dist")
    wheels = sorted(dist_dir.glob("*.whl"))
    if not wheels:
        print(f"No wheels found in {dist_dir}", file=sys.stderr)
        return 1

    failed = False
    for wheel in wheels:
        with zipfile.ZipFile(wheel) as archive:
            names = archive.namelist()

        has_index = UI_INDEX in names
        asset_count = sum(1 for name in names if name.startswith(UI_ASSETS_PREFIX))
        if has_index and asset_count > 0:
            if expected_ui is not None:
                with zipfile.ZipFile(wheel) as archive:
                    bundled_ui = {
                        name: archive.read(name)
                        for name in names
                        if name.startswith(UI_PREFIX) and not name.endswith("/")
                    }
                missing = sorted(expected_ui.keys() - bundled_ui.keys())
                extra = sorted(bundled_ui.keys() - expected_ui.keys())
                changed = sorted(
                    name
                    for name in expected_ui.keys() & bundled_ui.keys()
                    if expected_ui[name] != bundled_ui[name]
                )
                if missing or extra or changed:
                    failed = True
                    differences = []
                    if missing:
                        differences.append(f"missing {missing}")
                    if extra:
                        differences.append(f"unexpected {extra}")
                    if changed:
                        differences.append(f"changed {changed}")
                    print(
                        f"{wheel.name}: bundles a UI that differs from {compare_dir}: "
                        f"{'; '.join(differences)}. Rebuild the editor and the wheel.",
                        file=sys.stderr,
                    )
                    continue

            print(f"{wheel.name}: bundles the editor UI ({asset_count} assets)")
            continue

        failed = True
        missing = "index.html" if not has_index else "assets"
        print(
            f"{wheel.name}: missing the editor UI ({missing}). "
            "Build the editor before the wheel (`make build-py`).",
            file=sys.stderr,
        )

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
