"""Unified event model shared by all parsers and the rules engine."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import Enum


class Severity(str, Enum):
    CRITICAL = "critical"
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"
    INFO = "info"


# ascending severity, index-based comparison
SEVERITY_ORDER: list[Severity] = [
    Severity.INFO, Severity.LOW, Severity.MEDIUM, Severity.HIGH, Severity.CRITICAL,
]


def severity_at_least(value: Severity, floor: Severity) -> bool:
    return SEVERITY_ORDER.index(value) >= SEVERITY_ORDER.index(floor)


CONFIG_BASENAMES = {
    "settings.json", "settings.local.json",
    ".bashrc", ".zshrc", ".bash_profile", ".zprofile", ".profile",
    "Microsoft.PowerShell_profile.ps1",
    "authorized_keys", "known_hosts", "config",
}

SHELL_RC_NAMES = {
    ".bashrc", ".zshrc", ".bash_profile", ".zprofile", ".profile",
    "Microsoft.PowerShell_profile.ps1",
}


def path_basename(path: str) -> str:
    return path.replace("\\", "/").rstrip("/").rsplit("/", 1)[-1]


def is_config_path(path: str) -> bool:
    return path_basename(path) in CONFIG_BASENAMES


@dataclass
class Event:
    session_id: str
    project: str
    timestamp: datetime | None


@dataclass
class ShellCommand(Event):
    raw: str = ""
    cwd: str | None = None


@dataclass
class FileWrite(Event):
    path: str = ""
    is_config: bool | None = None  # None = auto-detect from path
    content: str | None = None

    def __post_init__(self) -> None:
        if self.is_config is None:
            self.is_config = is_config_path(self.path)


@dataclass
class NetworkRequest(Event):
    url: str = ""
    method: str | None = None


@dataclass
class McpToolCall(Event):
    server: str = ""
    tool: str = ""
    args_hint: str = ""
