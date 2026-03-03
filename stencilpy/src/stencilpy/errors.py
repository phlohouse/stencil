class StencilError(Exception):
    """Base exception for stencilpy."""


class VersionError(StencilError):
    """Discriminator cell value didn't match any known version."""


class ValidationError(StencilError):
    """Pydantic validation failed during extraction."""
