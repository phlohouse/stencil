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


def _fresh_asset_names(editor_dist: Path) -> set[str]:
    assets = editor_dist / "assets"
    if not assets.is_dir():
        return set()
    return {f"stencilpy/ui_dist/assets/{path.name}" for path in assets.iterdir() if path.is_file()}


def main(argv: list[str]) -> int:
    args = [arg for arg in argv[1:] if not arg.startswith("--")]
    compare_dir = None
    if "--compare-dir" in argv:
        index = argv.index("--compare-dir")
        compare_dir = Path(argv[index + 1]) if index + 1 < len(argv) else None

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
            if compare_dir is not None:
                expected = _fresh_asset_names(compare_dir)
                bundled = {name for name in names if name.startswith(UI_ASSETS_PREFIX)}
                if expected and not expected <= bundled:
                    failed = True
                    missing_assets = sorted(expected - bundled)
                    print(
                        f"{wheel.name}: bundles a stale editor UI, missing {missing_assets}. "
                        "Rebuild the editor and the wheel.",
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
