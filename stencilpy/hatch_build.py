from __future__ import annotations

import shutil
from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class CustomBuildHook(BuildHookInterface):
    """Bundle the editor UI that the package serves with ``stencil open``.

    ``editor/dist`` is only present when the editor has been built, so the hook
    falls back to the bundle committed in the repository instead of leaving the
    package without a UI.
    """

    def initialize(self, version: str, build_data: dict[str, object]) -> None:
        del version, build_data

        package_ui_dir = Path(self.root) / "src" / "stencilpy" / "ui_dist"
        editor_dist_dir = Path(self.root).parent / "editor" / "dist"

        if not editor_dist_dir.is_dir():
            if (package_ui_dir / "index.html").is_file():
                print(
                    "stencilpy: editor/dist not found, keeping the committed ui_dist bundle. "
                    "Run `make build-editor` for a fresh UI."
                )
                return
            raise RuntimeError(
                "stencilpy: no editor UI to bundle. Run `make build-editor` (or `make build-py`) "
                "before building the package."
            )

        if package_ui_dir.exists():
            shutil.rmtree(package_ui_dir)

        shutil.copytree(editor_dist_dir, package_ui_dir)
