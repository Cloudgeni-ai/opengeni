class PlatformError(Exception):
    """Base class for expected platform failures."""


class RepositoryError(PlatformError):
    """Raised when a repository operation cannot be completed."""


class RunNotFoundError(RepositoryError):
    def __init__(self, run_id: str) -> None:
        super().__init__(f"run not found: {run_id}")
        self.run_id = run_id


class DispatchError(PlatformError):
    """Raised when a run cannot be dispatched to the workflow backend."""


class SandboxProviderError(PlatformError):
    """Raised when the configured sandbox provider cannot be used."""
