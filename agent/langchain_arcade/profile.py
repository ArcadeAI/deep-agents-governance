"""The discovery profile: every model-facing string, as data.

`ArcadeMiddleware` contains no prompt text, no tool names, no descriptions, and
no message wording. All of it comes from a `DiscoveryProfile`, which is loaded
from YAML and layered so a deployment can override any part of it.

The load order, lowest priority first:

1. `resources/profile.yaml`, bundled with the package
2. `~/.config/arcade/deepagents-profile.yaml`
3. the file named by `$ARCADE_DISCOVERY_PROFILE`
4. mappings passed directly to `load_profile`

Layers deep-merge, so an override that sets only `system_prompt` inherits every
tool definition and template beneath it. A server-fetched profile slots in as
another layer between 1 and 4 once the Engine serves one.

Code binds to **roles** (`select`, `search`, `schema`, `execute`), never to tool
names. A profile is free to rename `arcade_select_tools` to anything; the
handler wiring keys off the role, so nothing breaks.

Templates use `string.Template` (`$name`) rather than `str.format`, so JSON
braces inside prompt text need no escaping.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from string import Template
from typing import TYPE_CHECKING, Any, Literal, get_args

import yaml

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping, Sequence

ToolRole = Literal["select", "search", "schema", "execute"]
"""The four things the middleware knows how to do. Names are profile data."""

TOOL_ROLES: tuple[ToolRole, ...] = get_args(ToolRole)

#: The one role a profile cannot omit. Promotion is selection plus
#: re-advertisement, so without `select` there is nothing to promote.
REQUIRED_TOOL_ROLE: ToolRole = "select"

ExecutionMode = Literal["promotion", "envelope"]
"""How discovered tools are called. This package implements `promotion`."""

SUPPORTED_MODE: ExecutionMode = "promotion"

PROFILE_ENV_VAR = "ARCADE_DISCOVERY_PROFILE"
_BUNDLED = Path(__file__).parent / "resources" / "profile.yaml"
_USER_CONFIG = Path("~/.config/arcade/deepagents-profile.yaml")


class ProfileError(ValueError):
    """A profile is missing a required part, or is internally inconsistent."""


@dataclass(frozen=True)
class MetaTool:
    """One meta-tool's model-facing definition.

    Attributes:
        role: The behavior this definition is bound to.
        name: Advertised tool name.
        description: Advertised description.
        input_schema: JSON Schema for the tool's arguments.
    """

    role: ToolRole
    name: str
    description: str
    input_schema: dict[str, Any]


@dataclass(frozen=True)
class Defaults:
    """Tuning values a deployment may want to change without a release."""

    max_promoted: int = 16
    select_limit: int = 5
    search_limit: int = 10
    digest_description_limit: int = 160
    max_candidate_hints: int = 5


@dataclass(frozen=True)
class DiscoveryProfile:
    """Everything the middleware needs that is content rather than mechanism.

    Attributes:
        version: Profile version, for cache keys and diagnostics.
        mode: Execution model the text is written for.
        system_prompt: Guidance appended to the system message, already
            substituted with the profile's own tool names.
        tools: Meta-tool definitions keyed by role.
        templates: Raw `string.Template` sources keyed by template name.
        defaults: Tuning values.
    """

    version: str
    mode: ExecutionMode
    system_prompt: str
    tools: dict[ToolRole, MetaTool]
    templates: dict[str, str] = field(default_factory=dict)
    defaults: Defaults = field(default_factory=Defaults)

    def tool(self, role: ToolRole) -> MetaTool:
        """Return the definition bound to `role`.

        Args:
            role: The role to look up.

        Returns:
            That role's meta-tool definition.
        """
        try:
            return self.tools[role]
        except KeyError:
            msg = (
                f"Discovery profile defines no {role!r} role. Check `roles` "
                f"before asking for a tool; roles are optional so a deployment "
                f"can decline to advertise what it cannot serve."
            )
            raise ProfileError(msg) from None

    @property
    def roles(self) -> frozenset[ToolRole]:
        """Roles this profile defines, which may be a subset of `TOOL_ROLES`."""
        return frozenset(self.tools)

    def name_of(self, role: ToolRole) -> str:
        """Return the advertised name for `role`.

        Args:
            role: The role to look up.

        Returns:
            The tool name this profile advertises for that role.
        """
        return self.tools[role].name

    def role_of(self, name: str) -> ToolRole | None:
        """Return the role a tool name is bound to, if any.

        Args:
            name: An advertised tool name from a tool call.

        Returns:
            The matching role, or `None` when the name is not a meta-tool.
        """
        for role, meta in self.tools.items():
            if meta.name == name:
                return role
        return None

    def render(self, key: str, /, **values: Any) -> str:
        """Render a template by name.

        Missing placeholders are left as-is rather than raising, so a
        hand-edited profile that drops a variable degrades to visible text
        instead of a crash mid-conversation.

        Args:
            key: Template name.
            **values: Substitutions.

        Returns:
            The rendered string, or `""` when the template is absent.
        """
        source = self.templates.get(key)
        if source is None:
            return ""
        return Template(source).safe_substitute(self._tool_names() | values)

    def _tool_names(self) -> dict[str, str]:
        """Tool-name substitutions available to every template."""
        return {f"{role}_tool": meta.name for role, meta in self.tools.items()}


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------


def _deep_merge(base: Mapping[str, Any], overlay: Mapping[str, Any]) -> dict[str, Any]:
    """Recursively merge `overlay` onto `base`, overlay winning.

    Nested mappings merge; every other type replaces. Lists replace rather than
    concatenate — a profile that overrides a tool's `required` list means to
    replace it.

    Args:
        base: Lower-priority mapping.
        overlay: Higher-priority mapping.

    Returns:
        A new merged mapping.
    """
    out = dict(base)
    for key, value in overlay.items():
        existing = out.get(key)
        if isinstance(existing, dict) and isinstance(value, dict):
            out[key] = _deep_merge(existing, value)
        else:
            out[key] = value
    return out


def _read_yaml(path: Path) -> dict[str, Any]:
    """Load a YAML mapping from `path`.

    Args:
        path: File to read.

    Returns:
        The parsed mapping.

    Raises:
        ProfileError: If the file is unreadable or is not a mapping.
    """
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        msg = f"Cannot read discovery profile at {path}: {exc}"
        raise ProfileError(msg) from exc
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        msg = f"Discovery profile at {path} must be a mapping, got {type(raw).__name__}"
        raise ProfileError(msg)
    return raw


def _layer_paths(env_var: str) -> list[Path]:
    """Return the file layers that exist, lowest priority first."""
    paths = [_BUNDLED, _USER_CONFIG.expanduser()]
    from_env = os.environ.get(env_var)
    if from_env:
        env_path = Path(from_env).expanduser()
        if not env_path.exists():
            msg = f"{env_var} points at {env_path}, which does not exist"
            raise ProfileError(msg)
        paths.append(env_path)
    return [p for p in paths if p.exists()]


def _build_tools(raw: Mapping[str, Any]) -> dict[ToolRole, MetaTool]:
    """Construct the role→definition map, validating completeness."""
    tools_raw = raw.get("tools")
    if not isinstance(tools_raw, dict):
        msg = "Discovery profile is missing a `tools` mapping"
        raise ProfileError(msg)

    if REQUIRED_TOOL_ROLE not in tools_raw:
        msg = (
            f"Discovery profile is missing the {REQUIRED_TOOL_ROLE!r} role. "
            f"Every other role is optional — a deployment that cannot serve one "
            f"should omit it rather than advertise a tool that always fails."
        )
        raise ProfileError(msg)

    unknown = [r for r in tools_raw if r not in TOOL_ROLES]
    if unknown:
        msg = (
            f"Discovery profile defines unknown tool roles: "
            f"{', '.join(sorted(unknown))}. Known roles: {', '.join(TOOL_ROLES)}"
        )
        raise ProfileError(msg)

    tools: dict[ToolRole, MetaTool] = {}
    for role in (r for r in TOOL_ROLES if r in tools_raw):
        entry = tools_raw[role]
        if not isinstance(entry, dict):
            msg = f"Discovery profile role {role!r} must be a mapping"
            raise ProfileError(msg)
        name = entry.get("name")
        if not isinstance(name, str) or not name:
            msg = f"Discovery profile role {role!r} needs a non-empty `name`"
            raise ProfileError(msg)
        schema = entry.get("input_schema")
        tools[role] = MetaTool(
            role=role,
            name=name,
            description=str(entry.get("description", "")).strip(),
            input_schema=schema
            if isinstance(schema, dict)
            else {"type": "object", "properties": {}},
        )

    names = [m.name for m in tools.values()]
    if len(set(names)) != len(names):
        msg = (
            f"Discovery profile assigns the same tool name to two roles: "
            f"{sorted(names)}"
        )
        raise ProfileError(msg)
    return tools


def _build_defaults(raw: Mapping[str, Any]) -> Defaults:
    """Construct `Defaults`, ignoring unknown keys rather than failing."""
    values = raw.get("defaults")
    if not isinstance(values, dict):
        return Defaults()
    known = {f.name for f in Defaults.__dataclass_fields__.values()}
    return Defaults(**{k: int(v) for k, v in values.items() if k in known})


def load_profile(
    *overrides: Mapping[str, Any] | str | Path,
    env_var: str = PROFILE_ENV_VAR,
    include_default_layers: bool = True,
) -> DiscoveryProfile:
    """Load the discovery profile, layering every configured source.

    Args:
        *overrides: Highest-priority layers, applied in the order given. Each is
            either a mapping or a path to a YAML file.
        env_var: Environment variable naming an override file. Pass a different
            name to isolate tests.
        include_default_layers: When `False`, skip the bundled, user-config, and
            environment layers and build only from `overrides`. Used to verify
            a standalone profile.

    Returns:
        The merged, validated profile.

    Raises:
        ProfileError: If a layer is unreadable, a required part is missing, or
            the profile's `mode` is not the one this package implements.

    Example:
        ```python
        # Reword the prompt, inherit everything else.
        profile = load_profile({"system_prompt": "Find tools with $select_tool."})
        ```
    """
    layers: list[Mapping[str, Any]] = []
    if include_default_layers:
        layers.extend(_read_yaml(p) for p in _layer_paths(env_var))
    for override in overrides:
        if isinstance(override, (str, Path)):
            layers.append(_read_yaml(Path(override).expanduser()))
        else:
            layers.append(override)

    if not layers:
        msg = "No discovery profile layers to load"
        raise ProfileError(msg)

    merged: dict[str, Any] = {}
    for layer in layers:
        merged = _deep_merge(merged, layer)

    mode = merged.get("mode", SUPPORTED_MODE)
    if mode != SUPPORTED_MODE:
        msg = (
            f"Discovery profile declares mode {mode!r}, but this package implements "
            f"{SUPPORTED_MODE!r}. An {mode!r} profile instructs the model to route "
            f"calls through an execution envelope, which promotion removes — the two "
            f"are not interchangeable."
        )
        raise ProfileError(msg)

    tools = _build_tools(merged)
    templates_raw = merged.get("templates")
    templates = (
        {str(k): str(v) for k, v in templates_raw.items()}
        if isinstance(templates_raw, dict)
        else {}
    )

    tool_names = {f"{role}_tool": meta.name for role, meta in tools.items()}
    # The prompt names the tools, and a profile may have renamed them, so it is
    # substituted once here rather than on every model call.
    prompt_source = str(merged.get("system_prompt", "")).strip()
    system_prompt = (
        Template(prompt_source).safe_substitute(tool_names) if prompt_source else ""
    )

    return DiscoveryProfile(
        version=str(merged.get("version", "0")),
        mode=SUPPORTED_MODE,
        system_prompt=system_prompt,
        tools=tools,
        templates=templates,
        defaults=_build_defaults(merged),
    )


def describe_layers(env_var: str = PROFILE_ENV_VAR) -> list[str]:
    """Return the profile layers currently in effect, lowest priority first.

    Args:
        env_var: Environment variable naming an override file.

    Returns:
        Human-readable paths, for diagnostics and `--doctor`-style output.
    """
    return [str(p) for p in _layer_paths(env_var)]


def iter_template_keys(profile: DiscoveryProfile) -> Iterable[str]:
    """Return the template names a profile defines.

    Args:
        profile: The profile to inspect.

    Returns:
        Sorted template names.
    """
    return sorted(profile.templates)


def missing_templates(profile: DiscoveryProfile, required: Sequence[str]) -> list[str]:
    """Return which of `required` the profile does not define.

    Args:
        profile: The profile to check.
        required: Template names the caller depends on.

    Returns:
        The missing names, sorted.
    """
    return sorted(set(required) - set(profile.templates))


__all__ = [
    "PROFILE_ENV_VAR",
    "REQUIRED_TOOL_ROLE",
    "TOOL_ROLES",
    "Defaults",
    "DiscoveryProfile",
    "MetaTool",
    "ProfileError",
    "ToolRole",
    "describe_layers",
    "iter_template_keys",
    "load_profile",
    "missing_templates",
]
