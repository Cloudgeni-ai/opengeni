# Derived from SPACE's space_smoke/model.py (https://github.com/perplexityai/SPACE, Apache-2.0,
# Copyright 2026 Perplexity AI) and changed for Opengeni compute; see compute/NOTICE.
"""Small internal data model for smoke results."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class Verdict(str, Enum):
    PASS = "pass"
    WARN = "warn"
    FAIL = "fail"
    INCONCLUSIVE = "inconclusive"
    INFRA_ERROR = "infra_error"

    @property
    def exit_code(self) -> int:
        """The process exit status that reports this verdict."""

        if self is Verdict.PASS:
            return 0
        if self is Verdict.WARN:
            return 42
        if self is Verdict.FAIL:
            return 1
        return 2


@dataclass(frozen=True)
class ScenarioResult:
    verdict: Verdict
    summary: str
    evidence: Mapping[str, Any] = field(default_factory=dict)
    cleanup_failures: tuple[str, ...] = ()
    diagnostics: tuple[str, ...] = ()

    @property
    def exit_code(self) -> int:
        return self.verdict.exit_code
