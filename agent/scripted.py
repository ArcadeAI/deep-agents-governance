"""A stateless scripted model, so the agent runs with no model key.

Every run makes the same three moves: select tools for the request, call
`LoanDesk_SearchLoans` for pending loans, and answer with what came back. The next move
is read from the messages so far rather than from an iterator, so a long-running
`mda dev` server can replay it on every thread.

Set `MODEL_ID` (for example `anthropic:claude-sonnet-5-5`) and the provider's key in
`.env` to swap in a real model.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult

SELECT = "arcade_select_tools"
TOOL = "LoanDesk_SearchLoans"


class ScriptedModel(BaseChatModel):
    def bind_tools(self, tools: Sequence[Any], **kwargs: Any) -> ScriptedModel:
        return self

    def _generate(self, messages: list[BaseMessage], stop: Any = None, run_manager: Any = None, **kwargs: Any) -> ChatResult:
        task = next((str(m.content) for m in reversed(messages) if isinstance(m, HumanMessage)), "")
        last = messages[-1] if messages else None
        if not isinstance(last, ToolMessage):
            move = AIMessage(content="", tool_calls=[{"name": SELECT, "args": {"tasks": [task]}, "id": "call_select", "type": "tool_call"}])
        elif last.name == SELECT:
            move = AIMessage(content="", tool_calls=[{"name": TOOL, "args": {"status": "pending"}, "id": "call_tool", "type": "tool_call"}])
        else:
            move = AIMessage(content=f"{TOOL} returned:\n\n{str(last.content)[:1500]}")
        return ChatResult(generations=[ChatGeneration(message=move)])

    @property
    def _llm_type(self) -> str:
        return "scripted"
