from __future__ import annotations

import json
from contextlib import ExitStack
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from importlib.resources import as_file, files
from pathlib import Path
from secrets import token_urlsafe
from threading import Thread
from time import sleep
from urllib.parse import unquote, urlparse


def has_bundled_ui() -> bool:
    try:
        return files("stencilpy").joinpath("ui_dist", "index.html").is_file()
    except ModuleNotFoundError:
        return False


class BundledUIServer:
    def __init__(
        self,
        *,
        directory: Path | None,
        host: str = "127.0.0.1",
        port: int = 0,
    ) -> None:
        self._stack = ExitStack()
        self._directory = directory
        self._launch_files: dict[str, Path] = {}
        self._launch_version: str | None = None
        self._launch_origin: str | None = None
        self._launch_path = f"/_stencil/{token_urlsafe(32)}"
        handler = self._create_handler(directory, self)
        self._server = ThreadingHTTPServer((host, port), handler)
        bound_host, bound_port = self._server.server_address[:2]
        self.url = f"http://{bound_host}:{bound_port}"
        self._thread = Thread(target=self._server.serve_forever, name="stencil-ui", daemon=True)
        self._thread.start()

    def set_launch_files(
        self,
        paths: dict[str, Path],
        *,
        version: str | None = None,
        origin: str | None = None,
    ) -> str:
        self._launch_files = paths
        self._launch_version = version
        self._launch_origin = origin
        return f"{self.url}{self._launch_path}"

    def wait(self) -> int:
        try:
            while self._thread.is_alive():
                sleep(0.5)
        except KeyboardInterrupt:
            return 130
        return 0

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)
        self._stack.close()

    @staticmethod
    def _create_handler(
        directory: Path | None, server: BundledUIServer,
    ) -> type[SimpleHTTPRequestHandler]:
        class SPARequestHandler(SimpleHTTPRequestHandler):
            def __init__(self, *args: object, **kwargs: object) -> None:
                super().__init__(*args, directory=str(directory) if directory else None, **kwargs)

            def send_head(self):  # type: ignore[override]
                request_path = urlparse(self.path).path
                if request_path.startswith("/_stencil/"):
                    self._serve_launch(request_path)
                    return None
                if directory is None:
                    self.send_error(404)
                    return None
                requested_path = Path(unquote(request_path).lstrip("/"))
                if not requested_path.parts or not _path_exists(directory, requested_path):
                    self.path = "/index.html"
                return super().send_head()

            def _serve_launch(self, request_path: str) -> None:
                expected_host = f"{self.server.server_address[0]}:{self.server.server_address[1]}"
                origin = self.headers.get("Origin")
                if self.headers.get("Host") != expected_host or (
                    origin and origin not in {server.url, server._launch_origin}
                ):
                    self.send_error(403)
                    return
                if not server._launch_files:
                    self.send_error(404)
                    return
                if request_path == server._launch_path:
                    body = json.dumps({
                        "schema": "schema" in server._launch_files,
                        "file": server._launch_files["file"].name if "file" in server._launch_files else None,
                        "version": server._launch_version,
                    }).encode()
                    content_type = "application/json"
                else:
                    name = request_path.removeprefix(server._launch_path + "/")
                    if name not in server._launch_files:
                        self.send_error(404)
                        return
                    try:
                        body = server._launch_files[name].read_bytes()
                    except OSError:
                        self.send_error(404, "Launch file is no longer readable")
                        return
                    content_type = "application/octet-stream"
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                if origin and origin == server._launch_origin:
                    self.send_header("Access-Control-Allow-Origin", origin)
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(body)

            def log_message(self, format: str, *args: object) -> None:
                return

        return SPARequestHandler


def start_bundled_ui_server() -> BundledUIServer | None:
    if not has_bundled_ui():
        return None

    stack = ExitStack()
    directory = stack.enter_context(as_file(files("stencilpy").joinpath("ui_dist")))
    server = BundledUIServer(directory=directory)
    server._stack = stack
    return server


def _path_exists(directory: Path, requested_path: Path) -> bool:
    if requested_path.is_absolute() or ".." in requested_path.parts:
        return False

    return (directory / requested_path).exists()
