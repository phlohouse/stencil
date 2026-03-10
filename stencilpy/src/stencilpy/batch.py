from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Generic, TypeVar

from pydantic import BaseModel

from .errors import StencilError

ModelT = TypeVar("ModelT", bound=BaseModel)


@dataclass(frozen=True, slots=True)
class ExtractionSuccess(Generic[ModelT]):
    path: Path
    model: ModelT


@dataclass(frozen=True, slots=True)
class ExtractionFailure:
    path: Path
    error: StencilError


@dataclass(frozen=True, slots=True)
class BatchExtractionResult(Generic[ModelT]):
    results: list[ExtractionSuccess[ModelT] | ExtractionFailure]
    successes: list[ExtractionSuccess[ModelT]]
    failures: list[ExtractionFailure]

    @property
    def files_scanned(self) -> int:
        return len(self.results)

    @property
    def has_failures(self) -> bool:
        return bool(self.failures)
