from __future__ import annotations

import shutil
from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class CustomBuildHook(BuildHookInterface):
    def initialize(self, version: str, build_data: dict[str, object]) -> None:
        del version, build_data

        package_ui_dir = Path(self.root) / "src" / "stencilpy" / "ui_dist"
        editor_dist_dir = Path(self.root).parent / "editor" / "dist"

        if package_ui_dir.exists():
            shutil.rmtree(package_ui_dir)

        if editor_dist_dir.is_dir():
            shutil.copytree(editor_dist_dir, package_ui_dir)
