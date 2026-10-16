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


    def test_launch_serves_only_named_files_with_token_and_allowed_origin(self, tmp_path):
        import json
        import pytest
        from urllib.error import HTTPError
        from urllib.request import Request

        selected = tmp_path / "selected.xlsx"
        selected.write_bytes(b"selected workbook")
        (tmp_path / "private.xlsx").write_bytes(b"private workbook")
        server = BundledUIServer(directory=None)
        endpoint = server.set_launch_files({"file": selected}, origin="http://localhost:5173")
        try:
            with urlopen(Request(endpoint, headers={"Origin": "http://localhost:5173"})) as response:
                assert response.headers["Access-Control-Allow-Origin"] == "http://localhost:5173"
                assert response.headers["Cache-Control"] == "no-store"
                assert json.loads(response.read())["file"] == "selected.xlsx"
            assert urlopen(endpoint + "/file").read() == b"selected workbook"
            for url, headers, code in [
                (endpoint, {"Origin": "https://example.com"}, 403),
                (endpoint, {"Host": "example.com"}, 403),
                (server.url + "/_stencil/wrong-token", {}, 404),
                (endpoint + "/../private.xlsx", {}, 404),
                (endpoint + "/schema", {}, 404),
                (server.url + "/private.xlsx", {}, 404),
                (server.url + "/", {}, 404),
            ]:
                with pytest.raises(HTTPError) as caught:
                    urlopen(Request(url, headers=headers))
                assert caught.value.code == code
        finally:
            server.close()
