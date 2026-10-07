"""Arcade tool discovery for Deep Agents.

Exposes the Arcade catalog to an agent through a small set of meta-tools rather
than a large static tool list. Selection turns a plain-English task into
concrete tools, which then appear as first-class tool definitions on the next
model call.

Every model-facing string — tool names, descriptions, argument schemas, the
system prompt, and each runtime message — lives in a `DiscoveryProfile` loaded
from YAML, not in Python. See `profile.py`.

Example:
    ```python
    from deepagents import create_deep_agent
    from langchain_arcade import ArcadeMiddleware, EngineProvider

    agent = create_deep_agent(
        model="claude-sonnet-5",
        middleware=[ArcadeMiddleware(provider=EngineProvider())],
    )
    ```
"""

from langchain_arcade._schema import SelectedTool, SelectedToolDict, parse_tools
from langchain_arcade._version import __version__
from langchain_arcade.cloud import (
    ArcadeCloudProvider,
    ArcadeCloudToolNames,
    AsyncToolCaller,
    ToolCaller,
)
from langchain_arcade.identity import (
    NO_IDENTITY_ERROR,
    NO_TRUSTED_IDENTITY_ERROR,
    USER_ID_CONFIG_KEY,
    USER_ID_CONTEXT_ATTR,
    USER_ID_ENV_VAR,
    ArcadeContext,
    describe_sources,
    resolve_user_id,
)
from langchain_arcade.middleware import (
    REQUIRED_TEMPLATES,
    ArcadeMiddleware,
    ArcadeState,
)
from langchain_arcade.profile import (
    PROFILE_ENV_VAR,
    TOOL_ROLES,
    Defaults,
    DiscoveryProfile,
    MetaTool,
    ProfileError,
    ToolRole,
    describe_layers,
    load_profile,
    missing_templates,
)
from langchain_arcade.provider import (
    ArcadeProvider,
    DiscoveryNotSupportedError,
    DiscoveryUnavailableError,
    EngineProvider,
    StaticProvider,
    ToolExecution,
)

__all__ = [
    "NO_IDENTITY_ERROR",
    "NO_TRUSTED_IDENTITY_ERROR",
    "PROFILE_ENV_VAR",
    "REQUIRED_TEMPLATES",
    "TOOL_ROLES",
    "USER_ID_CONFIG_KEY",
    "USER_ID_CONTEXT_ATTR",
    "USER_ID_ENV_VAR",
    "ArcadeCloudProvider",
    "ArcadeCloudToolNames",
    "ArcadeContext",
    "ArcadeMiddleware",
    "ArcadeProvider",
    "ArcadeState",
    "AsyncToolCaller",
    "Defaults",
    "DiscoveryNotSupportedError",
    "DiscoveryProfile",
    "DiscoveryUnavailableError",
    "EngineProvider",
    "MetaTool",
    "ProfileError",
    "SelectedTool",
    "SelectedToolDict",
    "StaticProvider",
    "ToolCaller",
    "ToolExecution",
    "ToolRole",
    "__version__",
    "describe_layers",
    "describe_sources",
    "load_profile",
    "missing_templates",
    "parse_tools",
    "resolve_user_id",
]
