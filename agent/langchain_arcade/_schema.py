"""Normalized tool schema and shape-tolerant parsing of Arcade payloads.

Arcade tool schemas reach us through several shapes depending on the transport:

* Engine `POST /v1/tools/select` — `{"query_id", "results": [{"task",
  "suggestions": [{"tool_name", "description", "input_schema", "toolkit",
  "version"}]}]}`
* Engine `POST /v1/tools/search` — `{"results": [<same suggestion shape>]}`
* Hub / Omni MCP `Arcade_SelectTools` — a JSON tool result carrying `tools`
  (or `results`, or `definitions`) of OpenAI-function-shaped dicts
  (`{"function": {"name", "description", "parameters"}}`).

Rather than branching on transport at every call site, every backend funnels
through `parse_tools` and yields `SelectedTool`. The parser is deliberately
lenient: payload shapes drift, and dropping one malformed entry beats failing a
whole selection.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, TypedDict, TypeGuard

from langchain_arcade._names import advertised_name, strip_version, toolkit_portion

_EMPTY_SCHEMA: dict[str, Any] = {"type": "object", "properties": {}}


class SelectedToolDict(TypedDict):
    """Serialized `SelectedTool`, as stored in agent state.

    Agent state must be JSON-serializable for checkpointing, so the catalog
    holds these rather than dataclass instances.
    """

    fqn: str
    name: str
    description: str
    input_schema: dict[str, Any]
    toolkit: str
    requires_auth: bool
    query_id: str


@dataclass(frozen=True)
class SelectedTool:
    """One Arcade tool, normalized across every payload shape.

    Attributes:
        fqn: Original fully-qualified name including version
            (`Slack.SendMessage@2.3.0`). This is what gets sent back to Arcade
            on execute.
        name: Model-facing advertised name (`Slack_SendMessage`).
        description: Tool description as returned by Arcade.
        input_schema: JSON Schema for the tool's inputs.
        toolkit: Owning toolkit (`Slack`).
        requires_auth: Whether Arcade flagged this tool as needing user
            authorization. Advisory only — execute is authoritative.
        query_id: Correlates this schema with the selection that produced it.
    """

    fqn: str
    name: str
    description: str
    input_schema: dict[str, Any] = field(default_factory=lambda: dict(_EMPTY_SCHEMA))
    toolkit: str = ""
    requires_auth: bool = False
    query_id: str = ""

    def to_dict(self) -> SelectedToolDict:
        """Serialize for storage in agent state.

        Returns:
            A JSON-serializable mapping.
        """
        return {
            "fqn": self.fqn,
            "name": self.name,
            "description": self.description,
            "input_schema": self.input_schema,
            "toolkit": self.toolkit,
            "requires_auth": self.requires_auth,
            "query_id": self.query_id,
        }

    @classmethod
    def from_dict(cls, data: SelectedToolDict | dict[str, Any]) -> SelectedTool:
        """Rebuild from its serialized form.

        Args:
            data: A mapping produced by `to_dict`.

        Returns:
            The reconstructed tool.
        """
        return cls(
            fqn=str(data.get("fqn", "")),
            name=str(data.get("name", "")),
            description=str(data.get("description", "")),
            input_schema=dict(data.get("input_schema") or _EMPTY_SCHEMA),
            toolkit=str(data.get("toolkit", "")),
            requires_auth=bool(data.get("requires_auth", False)),
            query_id=str(data.get("query_id", "")),
        )


def _first_str(source: dict[str, Any], *keys: str) -> str:
    """Return the first key present in `source` whose value is a non-empty str."""
    for key in keys:
        value = source.get(key)
        if isinstance(value, str) and value:
            return value
    return ""


# ---------------------------------------------------------------------------
# Arcade parameter lists -> JSON Schema
# ---------------------------------------------------------------------------

_VAL_TYPE_TO_JSON: dict[str, str] = {
    "string": "string",
    "integer": "integer",
    "number": "number",
    "float": "number",
    "boolean": "boolean",
    "json": "object",
    "object": "object",
    "array": "array",
}
"""Arcade `val_type` to JSON Schema `type`.

The vocabulary was taken from a live staging Engine: 419 parameters across 80
tools used only `string`, `integer`, `number`, `boolean`, and `array`, with
`inner_val_type` of `string` or `json`. Unknown types fall back to `string`,
which is the least surprising thing to show a model.
"""

_DEFAULT_JSON_TYPE = "string"


def _value_schema_to_json(value_schema: dict[str, Any]) -> dict[str, Any]:
    """Convert one Arcade `value_schema` into a JSON Schema fragment.

    Args:
        value_schema: An Arcade `value_schema` mapping.

    Returns:
        The equivalent JSON Schema fragment.
    """
    val_type = str(value_schema.get("val_type") or _DEFAULT_JSON_TYPE)
    json_type = _VAL_TYPE_TO_JSON.get(val_type, _DEFAULT_JSON_TYPE)
    out: dict[str, Any] = {"type": json_type}

    description = value_schema.get("description")
    if isinstance(description, str) and description:
        out["description"] = " ".join(description.split())

    if json_type == "array":
        out["items"] = _inner_schema(value_schema)
    elif json_type == "object":
        nested = _object_from_inner(value_schema)
        if nested is not None:
            out.update(nested)

    enum = value_schema.get("enum")
    if isinstance(enum, list) and enum:
        out["enum"] = list(enum)
    return out


def _object_from_inner(value_schema: dict[str, Any]) -> dict[str, Any] | None:
    """Build an object schema from `inner_properties` / `inner_required_keys`."""
    props = value_schema.get("inner_properties")
    if not isinstance(props, dict) or not props:
        return None
    properties = {
        str(key): (
            _value_schema_to_json(child)
            if isinstance(child, dict)
            else {"type": _DEFAULT_JSON_TYPE}
        )
        for key, child in props.items()
    }
    out: dict[str, Any] = {"properties": properties}
    required = value_schema.get("inner_required_keys")
    if isinstance(required, list) and required:
        out["required"] = [str(r) for r in required]
    return out


def _inner_schema(value_schema: dict[str, Any]) -> dict[str, Any]:
    """Build the `items` schema for an Arcade array parameter."""
    inner = str(value_schema.get("inner_val_type") or _DEFAULT_JSON_TYPE)
    item_type = _VAL_TYPE_TO_JSON.get(inner, _DEFAULT_JSON_TYPE)
    items: dict[str, Any] = {"type": item_type}
    if item_type == "object":
        nested = _object_from_inner(value_schema)
        if nested is not None:
            items.update(nested)
    return items


def parameters_to_json_schema(parameters: list[Any]) -> dict[str, Any]:
    """Convert an Arcade parameter list into a JSON Schema object.

    The Engine's `/v1/tools/select` returns `input_schema` as a *list* of
    parameter descriptors — `{name, description, required, inferrable,
    value_schema}` — not as JSON Schema. Promotion advertises this to the model
    as a tool's real argument schema, so it has to be translated rather than
    passed through.

    `inferrable` is dropped: it tells the Engine it may fill a value itself,
    which is not something the model needs to reason about, and encoding it
    would only invite the model to omit required arguments.

    Args:
        parameters: The `input_schema` list from a selection result.

    Returns:
        A JSON Schema object. Unusable entries are skipped rather than fatal.
    """
    properties: dict[str, Any] = {}
    required: list[str] = []
    for param in parameters:
        if not isinstance(param, dict):
            continue
        name = param.get("name")
        if not isinstance(name, str) or not name:
            continue
        raw_value_schema = param.get("value_schema")
        fragment = _value_schema_to_json(
            raw_value_schema if isinstance(raw_value_schema, dict) else {}
        )
        description = param.get("description")
        if isinstance(description, str) and description:
            fragment["description"] = " ".join(description.split())
        properties[name] = fragment
        if param.get("required"):
            required.append(name)

    out: dict[str, Any] = {"type": "object", "properties": properties}
    if required:
        out["required"] = required
    return out


def _extract_schema(source: dict[str, Any]) -> dict[str, Any]:
    """Pull an input schema out of any of the field names Arcade uses.

    Two wire formats reach here. The hub's MCP `SelectTools` returns real JSON
    Schema as a mapping. The Engine's REST `/v1/tools/select` returns a *list*
    of Arcade parameter descriptors, which needs translating — before this
    branch existed every Engine-selected tool was advertised with no parameters
    at all.
    """
    for key in ("input_schema", "inputSchema", "parameters", "input"):
        value = source.get(key)
        if isinstance(value, dict) and value:
            return value
        if isinstance(value, list) and value:
            return parameters_to_json_schema(value)
    return dict(_EMPTY_SCHEMA)


def _requires_auth(source: dict[str, Any]) -> bool:
    """Detect an authorization requirement across the field names in use."""
    for key in ("requires_auth", "requiresAuth", "requires_authorization"):
        if bool(source.get(key)):
            return True
    requirements = source.get("requirements")
    if isinstance(requirements, dict):
        authorization = requirements.get("authorization")
        if isinstance(authorization, dict) and authorization:
            return True
    return False


def _parse_one(entry: Any, query_id: str) -> SelectedTool | None:
    """Normalize a single tool entry, or return `None` if unusable."""
    if not isinstance(entry, dict):
        return None

    # OpenAI function shape nests everything under `function`; Arcade's REST
    # shape is flat. Merge so the flat lookups below cover both, with the
    # nested values winning since they are the more specific source.
    source: dict[str, Any] = dict(entry)
    function = entry.get("function")
    if isinstance(function, dict):
        source.update(function)

    fqn = _first_str(
        source, "tool_name", "qualified_name", "fully_qualified_name", "name"
    )
    if not fqn:
        return None

    version = _first_str(source, "version")
    # Search/select results carry `version` in its own field, so the
    # reconstructed FQN needs it re-attached for execute to pin the version.
    if version and "@" not in fqn:
        fqn = f"{strip_version(fqn)}@{version}"

    toolkit = _first_str(source, "toolkit", "toolkit_name") or toolkit_portion(fqn)

    return SelectedTool(
        fqn=fqn,
        name=advertised_name(fqn),
        description=_first_str(source, "description", "summary"),
        input_schema=_extract_schema(source),
        toolkit=toolkit,
        requires_auth=_requires_auth(source),
        query_id=query_id,
    )


def _flatten_suggestions(results: list[Any]) -> list[Any]:
    """Flatten the per-task suggestion lists returned by select."""
    entries: list[Any] = []
    for task_result in results:
        if isinstance(task_result, dict):
            suggestions = task_result.get("suggestions")
            if isinstance(suggestions, list):
                entries.extend(suggestions)
    return entries


def _is_select_shape(results: Any) -> TypeGuard[list[Any]]:
    """Detect the select shape: a results list whose members hold suggestions."""
    return isinstance(results, list) and any(
        isinstance(r, dict) and "suggestions" in r for r in results
    )


def _entries_from_dict(payload: dict[str, Any]) -> list[Any]:
    """Locate the tool list inside a dict payload of any known shape."""
    results = payload.get("results")
    if _is_select_shape(results):
        return _flatten_suggestions(results)
    for key in ("results", "tools", "definitions", "suggestions"):
        value = payload.get(key)
        if isinstance(value, list):
            return value
    # A bare single tool, which `Arcade_UseTool` error paths sometimes return.
    if any(key in payload for key in ("name", "tool_name", "function")):
        return [payload]
    return []


def parse_tools(payload: Any) -> tuple[list[SelectedTool], str]:
    """Extract tools and a query id from any Arcade discovery payload.

    Accepts the Engine select shape (`results[].suggestions[]`), the Engine
    search shape (`results[]`), the MCP tool-result shape (`tools`/`results`/
    `definitions`), a bare list, and a bare single tool. Unusable entries are
    skipped; duplicates collapse on advertised name, first occurrence winning
    (selection returns results in rank order).

    Args:
        payload: Decoded JSON from any Arcade discovery call.

    Returns:
        `(tools, query_id)`. `query_id` is `""` when the payload carries none.
    """
    query_id = ""
    entries: list[Any] = []
    if isinstance(payload, dict):
        query_id = _first_str(payload, "query_id", "queryId", "correlation_id")
        entries = _entries_from_dict(payload)
    elif isinstance(payload, list):
        entries = payload

    tools: dict[str, SelectedTool] = {}
    for entry in entries:
        tool = _parse_one(entry, query_id)
        if tool is not None and tool.name not in tools:
            tools[tool.name] = tool
    return list(tools.values()), query_id
