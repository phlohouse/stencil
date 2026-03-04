from __future__ import annotations

from collections.abc import Iterable
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from .errors import StencilError

try:
    from tqdm import tqdm
except ImportError:  # pragma: no cover
    tqdm = None  # type: ignore[assignment]


from .errors import ValidationError, VersionError

_ERROR_CLASSES: dict[str, type[StencilError]] = {
    "StencilError": StencilError,
    "VersionError": VersionError,
    "ValidationError": ValidationError,
}


class _ExtractionResult:
    """Serialisable result from a worker process."""

    __slots__ = ("path", "data", "schema_name", "version_key", "error")

    def __init__(
        self,
        path: Path,
        data: dict[str, Any] | None = None,
        schema_name: str | None = None,
        version_key: str | None = None,
        error: StencilError | None = None,
    ) -> None:
        self.path = path
        self.data = data
        self.schema_name = schema_name
        self.version_key = version_key
        self.error = error

    def __getstate__(self) -> dict[str, Any]:
        state: dict[str, Any] = {s: getattr(self, s) for s in self.__slots__}
        if state["error"] is not None:
            state["_error_cls"] = type(state["error"]).__name__
            state["_error_msg"] = str(state["error"])
            state["error"] = None
        return state

    def __setstate__(self, state: dict[str, Any]) -> None:
        cls_name = state.pop("_error_cls", None)
        msg = state.pop("_error_msg", None)
        for s in self.__slots__:
            object.__setattr__(self, s, state[s])
        if cls_name is not None:
            err_cls = _ERROR_CLASSES.get(cls_name, StencilError)
            object.__setattr__(self, "error", err_cls(msg))


def _extract_single(
    schema_paths: list[Path],
    excel_path: Path,
) -> _ExtractionResult:
    """Worker function for process-based extraction.

    Re-imports and reconstructs the Stencil object in the subprocess so
    everything is pickle-free.
    """
    from . import Stencil
    from .extractor import read_cell
    from .schema import StencilSchema

    for sp in schema_paths:
        stencil = Stencil(sp)
        for schema in stencil._schemas:
            disc_value = read_cell(excel_path, schema.discriminator_cell)
            disc_str = str(disc_value).strip() if disc_value is not None else ""
            if disc_str in schema.versions:
                try:
                    model = stencil.extract(excel_path)
                    return _ExtractionResult(
                        path=excel_path,
                        data=model.model_dump(),
                        schema_name=schema.name,
                        version_key=disc_str,
                    )
                except StencilError as e:
                    return _ExtractionResult(path=excel_path, error=e)

    return _ExtractionResult(
        path=excel_path,
        error=VersionError(
            f"No schema version matched the discriminator in '{excel_path}'"
        ),
    )


def extract_concurrent(
    schema_paths: list[Path],
    excel_paths: Iterable[Path],
    *,
    max_workers: int | None = None,
    progress: bool = True,
) -> list[_ExtractionResult]:
    """Extract data from many Excel files concurrently using multiprocessing.

    Parameters
    ----------
    schema_paths:
        Paths to .stencil.yaml schema files (or directories).
    excel_paths:
        Excel files to extract.
    max_workers:
        Max processes. Defaults to ``min(cpu_count, len(files))``.
    progress:
        Show a tqdm progress bar. Falls back to silent if tqdm is not installed.

    Returns
    -------
    list of _ExtractionResult in the same order as the input paths.
    """
    paths = list(excel_paths)
    if not paths:
        return []

    schema_paths = [Path(p) for p in schema_paths]

    if max_workers is None:
        import os

        max_workers = min(os.cpu_count() or 1, len(paths))

    results: list[_ExtractionResult] = [None] * len(paths)  # type: ignore[list-item]

    show_progress = progress and tqdm is not None

    with ProcessPoolExecutor(max_workers=max_workers) as executor:
        futures = {}
        for idx, ep in enumerate(paths):
            future = executor.submit(_extract_single, schema_paths, ep)
            futures[future] = idx

        iterator = as_completed(futures)
        if show_progress:
            iterator = tqdm(
                iterator,
                total=len(paths),
                desc="Extracting",
                unit="file",
            )

        for future in iterator:
            idx = futures[future]
            try:
                results[idx] = future.result()
            except Exception as exc:
                results[idx] = _ExtractionResult(
                    path=paths[idx], error=StencilError(str(exc))
                )

    return results
