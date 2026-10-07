"""Arcade tool-name normalization and repair.

Arcade returns fully-qualified, versioned names (`Slack.SendMessage@2.3.0`).
Model-facing tool names must match `^[a-zA-Z0-9_-]{1,128}$`, so the advertised
form replaces the separator and drops the version (`Slack_SendMessage`).

Both forms have to round-trip: promotion advertises the sanitized name, and
execution needs the original FQN to hand back to Arcade. `SelectedTool` carries
both, and the helpers here derive one from the other.

`find_candidates` handles the single most common model error with this pattern —
calling a tool by its bare method name (`SendMessage`) with no toolkit prefix.
Returning ranked candidates turns a dead end into a self-correcting retry.
"""

from __future__ import annotations

import re

_MAX_TOOL_NAME_LEN = 128
_ILLEGAL_CHARS = re.compile(r"[^a-zA-Z0-9_-]")


def strip_version(name: str) -> str:
    """Drop an Arcade version suffix.

    Args:
        name: Tool name, optionally suffixed with `@<version>`.

    Returns:
        The name with any `@version` suffix removed.

    Example:
        ```python
        strip_version("Slack.SendMessage@2.3.0")
        # 'Slack.SendMessage'
        ```
    """
    at = name.find("@")
    return name[:at] if at > 0 else name


def advertised_name(fqn: str) -> str:
    """Convert an Arcade FQN into a model-facing tool name.

    Drops the version and maps every character outside `[a-zA-Z0-9_-]` to an
    underscore, then truncates to the provider limit.

    Args:
        fqn: Fully-qualified Arcade tool name.

    Returns:
        A name safe to advertise in a tool definition.

    Example:
        ```python
        advertised_name("Slack.SendMessage@2.3.0")
        # 'Slack_SendMessage'
        ```
    """
    return _ILLEGAL_CHARS.sub("_", strip_version(fqn))[:_MAX_TOOL_NAME_LEN]


def method_portion(name: str) -> str:
    """Return just the method portion of a tool name.

    Tolerates both separators Arcade payloads use in practice (`Toolkit.Method`
    and `Toolkit_Method`). Splits on the last `.` when present, otherwise the
    first `_` — method names can themselves contain underscores
    (`Slack_List_Channels` → `List_Channels`).

    Args:
        name: Tool name in either separator convention, with or without version.

    Returns:
        The method portion, or the whole name if it has no separator.
    """
    stripped = strip_version(name)
    if "." in stripped:
        return stripped.rsplit(".", 1)[-1]
    if "_" in stripped:
        return stripped.split("_", 1)[1]
    return stripped


def toolkit_portion(name: str) -> str:
    """Return the toolkit portion of a tool name.

    Args:
        name: Tool name in either separator convention.

    Returns:
        The toolkit portion, or an empty string if the name has no separator.
    """
    stripped = strip_version(name)
    if "." in stripped:
        return stripped.rsplit(".", 1)[0]
    if "_" in stripped:
        return stripped.split("_", 1)[0]
    return ""


def find_candidates(known: list[str], partial: str, limit: int = 5) -> list[str]:
    """Return known tool names matching a partially-specified name.

    Handles the common failure where the model calls a tool by bare method name
    (`SendMessage`) instead of the advertised form (`Slack_SendMessage`).
    Matching is case-insensitive and separator-agnostic. Exact method matches
    rank above substring matches; ties sort alphabetically.

    Args:
        known: Advertised names currently in the catalog.
        partial: The name the model tried to call.
        limit: Maximum candidates to return.

    Returns:
        Up to `limit` candidate names, best matches first.

    Example:
        ```python
        find_candidates(["Slack_SendMessage", "Gmail_SendEmail"], "SendMessage")
        # ['Slack_SendMessage']
        ```
    """
    needle = partial.strip().lower()
    if not needle or not known:
        return []

    # A model that gets the toolkit right but the separator wrong
    # (`Slack.SendMessage`) should still match, so compare on both forms.
    needle_normalized = _ILLEGAL_CHARS.sub("_", strip_version(needle))

    exact: list[str] = []
    partial_hits: list[str] = []
    seen: set[str] = set()
    for name in known:
        if not name or name in seen:
            continue
        lowered = name.lower()
        method = method_portion(name).lower()
        if method == needle or lowered == needle_normalized:
            exact.append(name)
            seen.add(name)
        elif needle in method or needle_normalized in lowered:
            partial_hits.append(name)
            seen.add(name)

    exact.sort()
    partial_hits.sort()
    return (exact + partial_hits)[:limit]
