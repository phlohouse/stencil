from __future__ import annotations

from urllib.request import urlopen

from stencilpy.ui import BundledUIServer


class TestBundledUIServer:
    def test_serves_index_for_root_and_client_routes(self, tmp_path):
        ui_dir = tmp_path / "ui"
        ui_dir.mkdir()
        (ui_dir / "index.html").write_text("<html><body>Stencil UI</body></html>")

        server = BundledUIServer(directory=ui_dir)
        try:
            root_body = urlopen(server.url).read().decode()
            route_body = urlopen(f"{server.url}/schemas/new").read().decode()
        finally:
            server.close()

        assert "Stencil UI" in root_body
        assert "Stencil UI" in route_body

    def test_serves_existing_assets_without_falling_back_to_index(self, tmp_path):
        ui_dir = tmp_path / "ui"
        assets_dir = ui_dir / "assets"
        assets_dir.mkdir(parents=True)
        (ui_dir / "index.html").write_text("<html><body>Stencil UI</body></html>")
        (assets_dir / "app.js").write_text("console.log('asset')")

        server = BundledUIServer(directory=ui_dir)
        try:
            asset_body = urlopen(f"{server.url}/assets/app.js").read().decode()
        finally:
            server.close()

        assert "console.log('asset')" in asset_body
