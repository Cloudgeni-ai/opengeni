# OpenAI Agents SDK Python Internals

This reference is a source-backed map of the OpenAI Agents SDK Python
implementation. It focuses on what runs in Python userland, what crosses into
remote OpenAI or provider services, how the agent loop handles tools, approvals,
handoffs, sessions, run state, and sandbox execution, and where the main
performance and memory pressure points are likely to be.

## Scope And Evidence

**SDK source inspected:** `openai/openai-agents-python` at commit
`4f3c8a5379c1b44527c9a0a159d20b46755f4eaf`.

**Primary documentation inspected:**

- OpenAI Agents guide:
  <https://developers.openai.com/api/docs/guides/agents>
- OpenAI Agents sandbox guide:
  <https://developers.openai.com/api/docs/guides/agents/sandboxes>

**Evidence labels used below:**

- **Confirmed:** directly backed by SDK source or first-party docs.
- **Inference:** reasoned from source structure and control flow, but not
  measured or explicitly promised by docs.
- **Unknown:** depends on server-side or provider behavior not visible in the
  Python SDK source.

## Source Index

The most important first-party source locations are:

- `src/agents/run.py`: public runner entrypoints and the top-level async run
  loop. Key ranges:
  [L192-L219](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run.py#L192-L219),
  [L427-L554](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run.py#L427-L554),
  [L587-L641](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run.py#L587-L641),
  [L750-L860](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run.py#L750-L860),
  [L1160-L1252](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run.py#L1160-L1252),
  [L1264-L1473](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run.py#L1264-L1473),
  [L1479-L1534](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run.py#L1479-L1534),
  [L1544-L1588](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run.py#L1544-L1588).
- `src/agents/run_internal/run_loop.py`: single-turn model calls and streaming
  loop internals. Key ranges:
  [L274-L281](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_internal/run_loop.py#L274-L281),
  [L663-L843](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_internal/run_loop.py#L663-L843),
  [L860-L1165](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_internal/run_loop.py#L860-L1165),
  [L1234-L1681](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_internal/run_loop.py#L1234-L1681),
  [L1684-L1770](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_internal/run_loop.py#L1684-L1770),
  [L1772-L1894](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_internal/run_loop.py#L1772-L1894).
- `src/agents/run_internal/turn_resolution.py`: model response parsing,
  handoff/tool routing, and next-step selection. Key ranges:
  [L323-L510](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_internal/turn_resolution.py#L323-L510),
  [L547-L716](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_internal/turn_resolution.py#L547-L716),
  [L1420-L1858](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_internal/turn_resolution.py#L1420-L1858),
  [L1861-L1911](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_internal/turn_resolution.py#L1861-L1911).
- `src/agents/run_internal/run_steps.py`: internal step dataclasses and next-step
  variants. Key ranges:
  [L122-L136](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_internal/run_steps.py#L122-L136),
  [L167-L207](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_internal/run_steps.py#L167-L207).
- `src/agents/run_internal/tool_planning.py`: tool execution plan and
  concurrency shape. Key ranges:
  [L177-L190](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_internal/tool_planning.py#L177-L190),
  [L236-L263](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_internal/tool_planning.py#L236-L263),
  [L302-L331](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_internal/tool_planning.py#L302-L331),
  [L541-L623](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_internal/tool_planning.py#L541-L623).
- `src/agents/run_internal/tool_execution.py`: function tool execution,
  approvals, guardrails, and resume execution. Key ranges:
  [L1351-L1870](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_internal/tool_execution.py#L1351-L1870),
  [L1583-L1660](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_internal/tool_execution.py#L1583-L1660),
  [L1662-L1701](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_internal/tool_execution.py#L1662-L1701),
  [L1873-L2042](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_internal/tool_execution.py#L1873-L2042),
  [L2045-L2230](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_internal/tool_execution.py#L2045-L2230),
  [L2237-L2295](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_internal/tool_execution.py#L2237-L2295).
- `src/agents/run_internal/session_persistence.py`: session input
  preparation, persistence, compaction, and rewind. Key ranges:
  [L54-L171](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_internal/session_persistence.py#L54-L171),
  [L231-L328](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_internal/session_persistence.py#L231-L328),
  [L330-L363](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_internal/session_persistence.py#L330-L363),
  [L392-L470](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_internal/session_persistence.py#L392-L470).
- `src/agents/run_state.py`: durable run-state schema and approval resume.
  Key ranges:
  [L124-L148](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_state.py#L124-L148),
  [L183-L277](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_state.py#L183-L277),
  [L321-L355](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_state.py#L321-L355),
  [L655-L725](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_state.py#L655-L725),
  [L1027-L1090](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_state.py#L1027-L1090).
- `src/agents/run_context.py`: context, usage, and approval records.
  Key ranges:
  [L28-L60](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_context.py#L28-L60),
  [L300-L455](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_context.py#L300-L455),
  [L457-L464](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_context.py#L457-L464).
- `src/agents/items.py` and `src/agents/run_internal/items.py`: run item
  wrappers and conversion back to model input. Key ranges:
  [items.py L90-L153](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/items.py#L90-L153),
  [items.py L348-L651](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/items.py#L348-L651),
  [run_internal/items.py L66-L173](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_internal/items.py#L66-L173),
  [run_internal/items.py L296-L302](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_internal/items.py#L296-L302).
- `src/agents/result.py`: result surfaces and state population.
  Key ranges:
  [L70-L123](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/result.py#L70-L123),
  [L174-L223](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/result.py#L174-L223),
  [L239-L262](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/result.py#L239-L262).
- `src/agents/models/interface.py`: generic model/provider interface.
  Key ranges:
  [L37-L124](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/models/interface.py#L37-L124),
  [L127-L150](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/models/interface.py#L127-L150).
- `src/agents/models/openai_responses.py`: OpenAI Responses API adapter.
  Key ranges:
  [L377-L575](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/models/openai_responses.py#L377-L575),
  [L634-L833](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/models/openai_responses.py#L634-L833),
  [L1549-L1634](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/models/openai_responses.py#L1549-L1634).
- `src/agents/models/openai_chatcompletions.py`: Chat Completions adapter.
  Key ranges:
  [L48-L204](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/models/openai_chatcompletions.py#L48-L204),
  [L312-L432](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/models/openai_chatcompletions.py#L312-L432).
- `src/agents/memory/*`: session protocols, SQLite sessions, OpenAI
  conversation sessions, and Responses compaction.
  Key ranges:
  [session.py L13-L54](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/memory/session.py#L13-L54),
  [session.py L131-L150](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/memory/session.py#L131-L150),
  [sqlite_session.py L17-L77](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/memory/sqlite_session.py#L17-L77),
  [openai_conversations_session.py L12-L126](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/memory/openai_conversations_session.py#L12-L126),
  [openai_responses_compaction_session.py L24-L83](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/memory/openai_responses_compaction_session.py#L24-L83),
  [openai_responses_compaction_session.py L159-L235](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/memory/openai_responses_compaction_session.py#L159-L235).
- `src/agents/handoffs/*`: handoff schema and history mapper.
  Key ranges:
  [handoffs/__init__.py L42-L163](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/handoffs/__init__.py#L42-L163),
  [handoffs/history.py L71-L121](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/handoffs/history.py#L71-L121).
- `src/agents/guardrails.py` and `src/agents/run_internal/guardrails.py`:
  guardrail public and internal execution.
  Key ranges:
  [run_internal/guardrails.py L54-L174](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_internal/guardrails.py#L54-L174).
- `src/agents/lifecycle.py`: lifecycle hooks.
  Key range:
  [L13-L193](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/lifecycle.py#L13-L193).
- `src/agents/run_config.py`: run configuration, sandbox configuration,
  session controls, and filters.
  Key ranges:
  [L91-L137](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_config.py#L91-L137),
  [L141-L256](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run_config.py#L141-L256).
- `src/agents/sandbox/*`: sandbox agent and runtime harness.
  Key ranges:
  [sandbox_agent.py L14-L40](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/sandbox/sandbox_agent.py#L14-L40),
  [runtime.py L65-L162](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/sandbox/runtime.py#L65-L162),
  [runtime.py L180-L270](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/sandbox/runtime.py#L180-L270),
  [runtime_session_manager.py L179-L248](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/sandbox/runtime_session_manager.py#L179-L248),
  [runtime_session_manager.py L280-L391](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/sandbox/runtime_session_manager.py#L280-L391),
  [session/sandbox_client.py L100-L179](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/sandbox/session/sandbox_client.py#L100-L179),
  [session/base_sandbox_session.py L105-L143](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/sandbox/session/base_sandbox_session.py#L105-L143),
  [session/base_sandbox_session.py L204-L228](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/sandbox/session/base_sandbox_session.py#L204-L228),
  [session/base_sandbox_session.py L261-L304](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/sandbox/session/base_sandbox_session.py#L261-L304),
  [capabilities/tools/shell_tool.py L150-L249](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/sandbox/capabilities/tools/shell_tool.py#L150-L249),
  [capabilities/tools/apply_patch_tool.py L153-L220](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/sandbox/capabilities/tools/apply_patch_tool.py#L153-L220).

## Architecture Summary

**Confirmed:** The Python SDK is primarily a local async orchestration harness.
The runner owns the agent loop, model-call preparation, guardrail execution,
tool routing, local tool invocation, handoff switching, session persistence,
approval interruption/resume, run-state serialization, tracing hooks, and
sandbox session orchestration.

The public docs describe agents as applications that plan, call tools,
collaborate across specialists, and keep state for multi-step work. They also
distinguish direct API clients from the Agents SDK: use the SDK when the
application owns orchestration, tool execution, approvals, and state. The
source matches that framing: `Runner.run()` coordinates a loop over model
turns and Python-side side effects, while model providers implement the remote
generation boundary.

The highest-level components are:

| Component | Role | Evidence |
| --- | --- | --- |
| `Runner` / `AgentRunner` | Public run, sync run, streaming run, trace/run-state setup, turn loop | `run.py` |
| `Agent` | Immutable-ish agent configuration: instructions, tools, handoffs, model settings, hooks, guardrails, output type | Runner and handoff/tool code |
| `Model` interface | Generic async `get_response` and `stream_response` provider boundary | `models/interface.py` |
| `OpenAIResponsesModel` | Responses API implementation and tool/input conversion | `models/openai_responses.py` |
| `OpenAIChatCompletionsModel` | Chat Completions compatibility implementation | `models/openai_chatcompletions.py` |
| `RunItem` and `ModelResponse` | Local wrappers for model output, tool calls/results, reasoning, approvals, and final messages | `items.py` |
| `ProcessedResponse` and `SingleStepResult` | Internal per-turn routing and next-step state | `run_internal/run_steps.py` |
| `Session` | Async protocol for history storage | `memory/session.py` |
| `RunState` | Durable snapshot for human-in-the-loop and resume | `run_state.py` |
| `SandboxRuntime` | Harness-side preparation of sandbox agents, sessions, capabilities, and resume metadata | `sandbox/runtime.py` |

## Agent Loop

**Confirmed:** `Runner.run()` documents the loop directly:

1. Invoke the model for the current agent.
2. If final output is produced, return.
3. If a handoff is produced, switch to the new agent and loop.
4. Otherwise execute tools and loop.

It also documents `MaxTurnsExceeded`, guardrail exceptions, and that input
guardrails run only for the first agent. See `run.py`
[L192-L219](https://github.com/openai/openai-agents-python/blob/4f3c8a5379c1b44527c9a0a159d20b46755f4eaf/src/agents/run.py#L192-L219).

The concrete non-streaming path is:

1. **Normalize run configuration and resume state.** `AgentRunner.run()` creates
   or normalizes `RunConfig`, detects a resumed `RunState`, resolves context,
   and applies conversation settings. It also decides whether server-managed
   conversation tracking is in use via `conversation_id`, `previous_response_id`,
   or `auto_previous_response_id`.
2. **Prepare input and session history.** If an OpenAI server conversation
   tracker is active, local session history is not included in the prepared
   model input. Otherwise, `prepare_input_with_session()` fetches session
   history, normalizes input, deduplicates items, and drops orphaned function
   calls.
3. **Create tracing, run state, sandbox runtime, and prompt cache resolver.**
   The run loop maintains a `RunState` even for non-resume runs.
4. **Enter the turn loop.** On each turn it checks max-turn limits, runs
   first-turn input guardrails, prepares sandbox bindings if the current agent
   is a `SandboxAgent`, handles interrupted-turn resolution if resuming, then
   executes a single model turn.
5. **Call the model.** `run_single_turn()` gathers system instructions and
   prompt config concurrently, resolves tools and handoffs, prepares local or
   server-tracked input, and calls `get_new_response()`.
6. **Process model output.** `process_model_response()` maps provider output
   items into local `RunItem`s, queues local tool calls, handoff calls, MCP
   approval requests, shell/apply-patch calls, and hosted tool result items.
7. **Execute side effects.** `execute_tools_and_side_effects()` builds and runs
   a tool plan, collects interruptions, runs handoff callbacks, and decides the
   next step.
8. **Persist new history.** The runner appends raw model responses, generated
   items, and session items. When session persistence is enabled, it saves
   incremental session items.
9. **Return, hand off, interrupt, or loop.** The next step is one of final
   output, handoff to another agent, interruption for approval/human input, or
   run-again.
10. **Release references and cleanup.** The runner clears per-turn item lists to
   reduce retained references, finalizes spans, closes sandbox/runtime resources,
   and disposes model providers where needed.

### Streaming Loop

**Confirmed:** The streaming path uses the same conceptual loop, but emits raw
provider events and higher-level run item events through a queue. The SDK still
waits for the terminal `ModelResponse`, then runs the same response processing
and side-effect planning to determine whether to return, hand off, interrupt, or
loop. The streaming implementation filters already-emitted items to avoid
duplicate run item events.

**Inference:** Streaming improves time to first visible model event, but it does
not eliminate the post-response latency for Python-side tool execution,
approval handling, handoff callbacks, output guardrails, or session persistence.

## Python Userland Versus Remote Boundaries

| Area | Python userland | Remote API/service boundary | Status |
| --- | --- | --- | --- |
| Agent loop | Turn loop, next-step decisions, max-turn handling, local generated item history | Model generation | Confirmed |
| Model calls | Input/tool conversion, model provider selection, retry wrapper, hooks, usage aggregation | `responses.create`, Responses streaming endpoint, or `chat.completions.create` | Confirmed |
| Function tools | Schema exposure, approval checks, guardrails, hooks, invocation of Python callable | Only if the user callable itself calls remote systems | Confirmed |
| Hosted tools | SDK converts tool definitions and records output items | OpenAI/hosted tool execution during model response | Confirmed that SDK treats them as already run; hosted internals unknown |
| Handoffs | Tool-like handoff definitions, callback invocation, agent switch, history mapping | Model chooses handoff tool call | Confirmed |
| Sessions | Protocol, SQLite/local store, preparation, persistence, compaction wrapper | OpenAI Conversations session and Responses compaction API | Confirmed |
| Approvals | Approval records, `ToolApprovalItem`, interruption result, resume decisions | Human/UI or caller approval decision outside SDK | Confirmed |
| Run state | JSON schema, snapshot, approval decisions, generated/session items, sandbox resume payload | External storage chosen by application | Confirmed |
| Sandbox | Harness prepares sandbox agent, session manager, capability tools, resume metadata | Sandbox backend session, exec/files/ports/snapshots depending on client/provider | Confirmed; provider internals unknown |
| Tracing | Span creation/context and hooks in SDK | Trace export/storage backend | Confirmed at SDK boundary; backend details outside this review |

### Model Calls

**Confirmed:** The generic model boundary is `Model.get_response()` and
`Model.stream_response()` in `models/interface.py`. Those methods accept
Responses-style input, tools, handoffs, output schema, model settings, optional
`previous_response_id`, optional `conversation_id`, prompt config, and tracing.

**Confirmed:** `OpenAIResponsesModel` builds a Responses API request with model,
input, tools, prompt, `previous_response_id`, `conversation`, `parallel_tool_calls`,
reasoning, metadata, prompt cache retention, and other settings, then calls
`client.responses.create()` or a streaming Responses endpoint.

**Confirmed:** `OpenAIChatCompletionsModel` converts the same SDK input into
Chat Completions messages/tools and calls `client.chat.completions.create()`.
The Chat Completions adapter does not use `previous_response_id` or
`conversation_id` as server-managed state inputs.

### Hosted Tools

**Confirmed:** `ProcessedResponse.has_tools_or_approvals_to_run()` only returns
true for local work: handoffs, function tools, computer actions, custom tools,
local shell, shell, apply patch, or MCP approval callbacks. The source comment
states hosted tools have already run before the SDK processes the response.

**Unknown:** The execution internals, scheduling, resource limits, billing
shape, and latency profile of hosted tools are server-side platform behavior,
not visible in the Python SDK.

### Sandbox

**Confirmed from docs:** The sandbox feature has a control-plane split. The
harness owns the agent loop, model calls, tool routing, handoffs, approvals,
tracing, recovery, and run state. The sandbox compute plane owns isolated
filesystem, shell, packages, mounted data, ports, snapshots, and controlled
external access. The docs also state sandbox agents are currently available in
the Python Agents SDK.

**Confirmed from source:** `SandboxAgent` extends `Agent` and has a
`default_manifest`, `base_instructions`, capabilities, `run_as`, and a
concurrency guard. `SandboxRuntime.prepare_agent()` acquires the public agent,
ensures a sandbox session, binds capabilities, processes input, and clones the
agent into an execution agent with sandbox instructions and tools.

**Confirmed from docs and source:** sandbox session resolution prefers:

1. a live `run_config.sandbox.session`;
2. session state from resumed `RunState`;
3. explicit `run_config.sandbox.session_state`;
4. a fresh session from `run_config.sandbox.manifest` or
   `agent.default_manifest`.

**Unknown:** Exact isolation guarantees, startup time, snapshot durability,
network policy, cost, and provider-side concurrency behavior depend on the
sandbox backend.

## Tools, Approvals, Handoffs, And Side Effects

### Tool Planning And Execution

**Confirmed:** `process_model_response()` scans every model output item and
routes it into local data structures:

- message items;
- reasoning items;
- handoff function calls;
- function tool calls;
- computer actions;
- local shell calls;
- shell calls;
- apply patch calls;
- custom tool calls;
- MCP approval requests and MCP list/call items;
- hosted items such as file search, web search, image generation, code
  interpreter, compaction, and tool search calls/outputs.

If the model emits a tool call without a matching local tool, the SDK raises a
`ModelBehaviorError`.

**Confirmed:** `ToolExecutionPlan` buckets function, computer, custom, shell,
apply patch, local shell, MCP callback, and interruption work. The default
execution path has `parallel=True`.

**Confirmed:** Function tools are scheduled as separate asyncio tasks and the
batch executor drains them as tasks complete. Tool input guardrails, approval
checks, lifecycle hooks, and tool output guardrails are all part of the Python
execution path.

**Confirmed:** Tool families are gathered concurrently, but some families are
serial internally. Function tools run concurrently per call. Computer actions,
custom tools, shell calls, apply-patch calls, and local-shell calls are executed
with serial loops inside their family handlers.

**Inference:** A run with many independent Python function tools can overlap
I/O-bound tool latency. A run with many shell or apply-patch calls will not get
the same intra-family concurrency unless that implementation changes or a
custom tool performs its own concurrency.

### Human Approval Flow

**Confirmed:** Function tools can require approval. When a function tool needs
approval and no prior decision exists, the SDK emits a `ToolApprovalItem` and
returns an interruption. The caller can serialize the `RunState`, approve or
reject the tool call on that state, then resume the run.

**Confirmed:** Rejections can produce a synthetic tool output message back to
the model. Approvals and rejections are stored in `RunContextWrapper` approval
records and serialized through `RunState`.

**Confirmed:** `ToolApprovalItem.to_input_item()` raises because approval
placeholders are not valid model input. Internal conversion code explicitly
filters approval items when turning run items back into input.

### Handoffs

**Confirmed:** A handoff is represented as a tool-like object with a tool name,
description, JSON input schema, `on_invoke_handoff`, target `agent_name`,
optional input filter, optional history nesting, strict schema settings, and an
enabled predicate.

**Confirmed:** If multiple handoff calls are present, the SDK executes the
first actual handoff and emits ignored outputs for the others. The handoff
callback returns the next agent. The runner then records a `HandoffOutputItem`,
runs lifecycle hooks, optionally applies a handoff input filter or nested
history mapper, sets the current agent to the new agent, and continues the
outer loop.

**Confirmed:** The default nested handoff history mapper summarizes prior
history into a single assistant message. That is a local history-shaping
operation, not a remote model call by itself.

## Sessions, Run State, And Conversation State

### Sessions

**Confirmed:** `Session` is a Python protocol with async methods:
`get_items(limit)`, `add_items(items)`, `pop_item()`, `clear_session()`, and
`session_id`.

**Confirmed:** `prepare_input_with_session()` fetches session history, converts
and normalizes history plus new input, applies an optional
`session_input_callback`, deduplicates, drops orphan function calls, and returns
both model input and items to persist.

**Confirmed:** `save_result_to_session()` persists new input and output items
incrementally, tracks how many current-turn items were persisted, deduplicates,
and calls `session.add_items()`.

**Confirmed:** `SQLiteSession` is local. Its default path is `:memory:`; file
paths persist. It uses a shared connection for in-memory sessions, thread-local
file connections, WAL mode for files, and a process-local file lock.

**Confirmed:** `OpenAIConversationsSession` is remote. It creates an OpenAI
conversation and uses `conversations.items.list/create/delete` plus
`conversations.delete`.

**Confirmed:** `OpenAIResponsesCompactionSession` wraps another session and
uses `responses.compact`. Its default trigger compacts when there are at least
10 candidate items. It can compact using `previous_response_id` or explicit
input, then clears the underlying session and stores the compacted output.

### Server-Managed Conversations

**Confirmed:** If `conversation_id`, `previous_response_id`, or
`auto_previous_response_id` are active, the runner uses an
`OpenAIServerConversationTracker`. In that mode, session history is not included
in the prepared model input and local session persistence is disabled for that
run.

**Inference:** Server-managed conversations reduce local history replay and
client-side token assembly, but they move concurrency, locking, and storage
semantics to the OpenAI API. The Python SDK has retry and rewind logic for local
session persistence, but server-side conflict behavior is outside this source
review.

### Run State

**Confirmed:** `RunState` is a durable snapshot for pause/resume and
human-in-the-loop flows. Current schema version is `1.9`; schema summaries
mention HITL snapshots, reasoning policy, trace semantics, request IDs,
approval rejection messages, duplicate-name agent identities, sandbox resume
state, prompt cache keys, pending custom tools, and tool-origin metadata.

**Confirmed:** `RunState` stores current turn, current/starting agent,
original input, model responses, context wrapper, generated items, session
items, max turns, final output schema, last agent, input/output guardrail
results, current interruption, last processed response, persisted session item
count, conversation and previous response IDs, tool-use tracker snapshot, trace
state, sandbox payload, and schema version.

**Confirmed:** `RunResult.to_state()` is populated from result data by
`_populate_state_from_result()`. Approval decisions are applied through
`RunState.approve()` and `RunState.reject()`, which update context approvals.
`RunState.to_json()` serializes the snapshot; `from_string()` and `from_json()`
rebuild it.

**Inference:** Large or long-running HITL workflows can produce large run-state
payloads because model responses, generated items, session items, context,
approval metadata, trace state, and sandbox resume metadata all serialize into
the state document.

## Data Representations

**Confirmed:** The SDK uses OpenAI Responses-style items internally even when
adapting to Chat Completions. Important local representations include:

- `ModelResponse`: provider output list, usage, response ID, request ID, and a
  helper to convert output to input items.
- `RunItemBase`: wraps a raw item and agent reference. It can convert raw
  Pydantic/dict output into an input item. It supports weak references and
  `release_agent()` to reduce retained agent references.
- Tool/run items: `ToolCallItem`, `ToolCallOutputItem`, `ReasoningItem`, MCP
  items, `CompactionItem`, and `ToolApprovalItem`.
- `ProcessedResponse`: grouped model output plus queues for handoffs, function
  tools, computer actions, custom tools, shell/apply-patch/local-shell work,
  and MCP approval callback work.
- `SingleStepResult`: original input, model response, pre-step items, new step
  items, next step, guardrail results, optional session items, and processed
  response.
- `RunResultBase`: original input, new items, raw responses, final output,
  input/output guardrail results, context wrapper, trace metadata, and sandbox
  metadata.

**Confirmed:** Conversion back to model input is explicit. Internal helpers
skip approval placeholders, can strip reasoning IDs, drop orphan function calls,
prepare generated history, and deduplicate input items while preferring the
latest copy.

## Async, Concurrency, And Hot Paths

**Confirmed concurrency points:**

- The public async runner is the primary API. `run_sync()` bridges into an event
  loop and raises if called from an already-running loop.
- System instructions and prompt config are fetched concurrently in single-turn
  execution.
- Input guardrails and output guardrails run concurrently and cancel remaining
  guardrails after a tripwire.
- In the non-streaming runner, first-turn input guardrails can run while the
  model task is already in flight; the runner can cancel the model task if a
  guardrail trips.
- Function tool calls are scheduled concurrently.
- Tool families are gathered concurrently by the tool plan, but several
  families are serial inside their own executor.
- MCP approval callbacks are gathered concurrently.
- Sandbox manifest materialization has default concurrency controls for
  manifest entries and local directory files.

**Confirmed hot-path operations inside the SDK:**

- input normalization and conversion to Responses-style input items;
- session history fetch, dedupe, orphan-call pruning, and optional callback;
- tool and handoff conversion for model requests;
- provider request construction and serialization;
- response-output iteration in `process_model_response()`;
- creation of `RunItem` wrappers and internal tool-run records;
- approval lookup and guardrail execution;
- session persistence and JSON serialization;
- run-state serialization for pause/resume;
- sandbox manifest application, snapshot restore/persist, and capability tool
  routing when sandbox agents are used.

**Inference:** For typical model-backed agents, wall time is dominated by model
API latency, token volume, hosted tool latency, local tool I/O, and sandbox
startup or command latency. Python overhead is likely secondary unless the run
has very large histories, many tool calls, heavy Pydantic serialization, large
run-state snapshots, or CPU-bound Python tools running inside the event loop.

## Performance Findings

These findings are not benchmark results. They are code-path analysis unless
marked as confirmed.

1. **Model and hosted-tool calls are the largest likely latency boundary.**
   Confirmed source shows Responses and Chat Completions calls are remote API
   calls. Inference: network latency, queueing, model compute, tool-use rounds,
   and token volume dominate many runs.
2. **Context size affects both remote and local cost.** Confirmed source shows
   local history assembly, deduplication, and conversion. Inference: more input
   items also increase prompt tokens, request size, JSON serialization time, and
   memory retained by results/run state.
3. **Sessions are a major scaling control.** Confirmed controls include
   session limits, session input callbacks, server-managed conversation mode,
   and Responses compaction. Inference: using these controls is important for
   long-running agents because raw history replay grows linearly.
4. **Function tool concurrency is useful but bounded.** Confirmed: function
   tools run as tasks, while several other tool families run serially inside
   their executor. Inference: I/O-bound Python functions benefit most; CPU-bound
   tools should be offloaded by user code.
5. **Streaming improves observability and first-token latency, not necessarily
   total turn latency.** Confirmed: side-effect processing happens after the
   terminal streamed response is built. Inference: any post-response tools,
   approvals, handoffs, output guardrails, and session writes still add tail
   latency.
6. **Sandbox startup and workspace operations can dominate sandboxed runs.**
   Confirmed source starts/resumes sessions, prepares workspace, applies
   manifests, restores and persists snapshots, and routes shell/files through a
   backend. Inference: startup, package install, mounts, snapshot size, and
   command execution are likely critical for sandbox throughput.
7. **Retry and rewind paths need idempotent thinking.** Confirmed source has
   retry wrappers around model calls and session rewind logic. Inference:
   applications should make local side effects idempotent or defer irreversible
   side effects until after approvals because retries can add cost and
   complexity.

## Memory Efficiency Findings

1. **The runner accumulates several item lists.** Confirmed: run state and
   result structures retain model responses, generated items, session items,
   new items, guardrail results, processed responses, and context data.
2. **The SDK deliberately releases some agent references.** Confirmed:
   `RunResult.release_agents()` and `RunResult.__del__()` release strong agent
   references, `RunItemBase` supports weak references, and the runner clears
   per-turn pre-step/new-step item lists after use.
3. **Session storage can move history out of process memory, but not eliminate
   serialization work.** Confirmed: SQLite file sessions persist to disk, and
   OpenAI Conversations sessions store items remotely. Inference: the active
   prepared input still needs to be materialized for local model calls unless
   server-managed conversation state avoids local replay.
4. **Compaction reduces active history at the cost of another remote call.**
   Confirmed: Responses compaction can replace underlying session history with
   compacted output. Inference: this trades latency/cost for bounded context
   and smaller future histories.
5. **RunState payloads can grow large.** Confirmed: `RunState.to_json()` stores
   model responses, generated/session items, approvals, context payload, trace
   state, and sandbox resume state. Inference: production HITL systems should
   store state in durable storage and monitor payload size.
6. **Sandbox snapshots and memory artifacts are workspace-size sensitive.**
   Confirmed: sandbox sessions can restore and persist snapshots, while sandbox
   memory writes durable files. Inference: large workspaces increase snapshot
   and file-operation cost unless manifests, mounts, and cleanup policies are
   controlled.

## Generic Orchestration Versus Provider-Backed Behavior

**Generic SDK orchestration:**

- `Runner`, `AgentRunner`, and turn-loop state transitions.
- `Agent` configuration and lifecycle hooks.
- Generic `Model` and `ModelProvider` interfaces.
- `RunItem`, `ModelResponse`, `ProcessedResponse`, `SingleStepResult`,
  `RunResult`, and `RunState` representations.
- Tool planning, local function invocation, guardrails, handoffs, and approvals.
- Session protocol and local SQLite implementation.
- Sandbox harness abstractions: client/session interfaces, runtime preparation,
  capability binding, and resume metadata.

**Provider-backed behavior:**

- OpenAI Responses API generation, streaming, hosted tools, prompt cache
  retention, reasoning fields, server-managed conversations, and response IDs.
- OpenAI Chat Completions adapter behavior and limitations.
- OpenAI Conversations session storage.
- OpenAI Responses compaction.
- Hosted sandbox backend behavior when a provider-backed sandbox client is used.
- Trace export/storage backend behavior.

**Rule of thumb:** if the code path is in `Runner`, `run_internal`, `items`,
`run_state`, `handoffs`, `guardrails`, or the session protocol, it is mostly
SDK orchestration. If it crosses `client.responses.*`, `client.chat.*`,
`client.conversations.*`, a hosted tool, or a sandbox backend client/session, it
is provider-backed behavior.

## Practical Design Implications

- Use server-managed conversations or session compaction for long histories
  where raw replay would dominate token and serialization cost.
- Use `SessionSettings.limit` and `session_input_callback` to bound model input
  deliberately.
- Treat Python function tools as async side-effect boundaries. Make them
  idempotent where possible, and avoid CPU-bound work directly in the event
  loop.
- Use human approval for irreversible tools. The approval path is a first-class
  interruption/resume flow, not an exception path.
- Use sandbox agents when filesystem/shell isolation and persistent workspace
  state matter, but budget for session startup, manifest materialization, and
  snapshot cost.
- Keep run-state payloads out of request/response hot paths when workflows can
  pause for a long time or carry large histories.
- For streaming UX, remember that visible stream events can arrive before local
  tools and handoffs complete.

## Unknowns And Open Questions

- No performance or memory benchmarks were found in this review. Latency and
  memory statements here are source-based inference unless explicitly marked
  confirmed.
- Hosted tool implementation details are remote platform behavior. The SDK
  confirms that hosted tools are already run by the time response items are
  processed, but not how they are scheduled or metered.
- Sandbox backend guarantees are provider-specific. The core SDK exposes
  abstract clients/sessions, but exact isolation, startup latency, network
  controls, billing, snapshot durability, and concurrent execution limits are
  not knowable from the core source alone.
- Server-managed conversation storage, conflict resolution, retention, and
  concurrency behavior are OpenAI API semantics, not fully visible in the SDK.
- Custom `ModelProvider` implementations may diverge in response IDs, streaming
  event semantics, retry behavior, hosted tool support, and conversation state.
- Sandbox memory quality and cost depend on model behavior, prompts, file
  contents, and runtime state; the SDK source shows the mechanism, not its
  empirical quality.
