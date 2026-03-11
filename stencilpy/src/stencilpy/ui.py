from __future__ import annotations

from contextlib import ExitStack
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from importlib.resources import as_file, files
from pathlib import Path
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
        directory: Path,
        host: str = "127.0.0.1",
        port: int = 0,
    ) -> None:
        self._stack = ExitStack()
        self._directory = directory
        handler = self._create_handler(directory)
        self._server = ThreadingHTTPServer((host, port), handler)
        bound_host, bound_port = self._server.server_address[:2]
        self.url = f"http://{bound_host}:{bound_port}"
        self._thread = Thread(target=self._server.serve_forever, name="stencil-ui", daemon=True)
        self._thread.start()

    def wait(self) -> int:
        try:
            while self._thread.is_alive():
                sleep(0.5)
        except KeyboardInterrupt:
            self.close()
            return 130
        return 0

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)
        self._stack.close()

    @staticmethod
    def _create_handler(directory: Path) -> type[SimpleHTTPRequestHandler]:
        class SPARequestHandler(SimpleHTTPRequestHandler):
            def __init__(self, *args: object, **kwargs: object) -> None:
                super().__init__(*args, directory=str(directory), **kwargs)

            def send_head(self):  # type: ignore[override]
                requested_path = Path(unquote(urlparse(self.path).path).lstrip("/"))
                if not requested_path.parts or not _path_exists(directory, requested_path):
                    self.path = "/index.html"
                return super().send_head()

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
