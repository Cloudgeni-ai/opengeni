# Temporal Integration

Snapshot date: 2026-04-16.

This reference comes from `openai-agents-sdk-intel` and is cross-linked with storage/state persistence guidance from the merged skill.

## Canonical Sources

- Temporal blog: `https://temporal.io/blog/announcing-openai-agents-sdk-integration`
- Temporal SDK source tree: `https://github.com/temporalio/sdk-python/tree/447472e51f8c39c3a4e5cee08c524d72d09a774c/temporalio/contrib/openai_agents`
- Temporal SDK README: `https://github.com/temporalio/sdk-python/blob/447472e51f8c39c3a4e5cee08c524d72d09a774c/temporalio/contrib/openai_agents/README.md`
- Temporal samples: `https://github.com/temporalio/samples-python/tree/29fc4af7c1f350a30cd1d45b8ead4b3c9494aec4/openai_agents`

Important source files at Temporal SDK commit `447472e51f8c39c3a4e5cee08c524d72d09a774c`:

- `_temporal_openai_agents.py`: `https://github.com/temporalio/sdk-python/blob/447472e51f8c39c3a4e5cee08c524d72d09a774c/temporalio/contrib/openai_agents/_temporal_openai_agents.py`
- `_openai_runner.py`: `https://github.com/temporalio/sdk-python/blob/447472e51f8c39c3a4e5cee08c524d72d09a774c/temporalio/contrib/openai_agents/_openai_runner.py`
- `_invoke_model_activity.py`: `https://github.com/temporalio/sdk-python/blob/447472e51f8c39c3a4e5cee08c524d72d09a774c/temporalio/contrib/openai_agents/_invoke_model_activity.py`
- `workflow.py`: `https://github.com/temporalio/sdk-python/blob/447472e51f8c39c3a4e5cee08c524d72d09a774c/temporalio/contrib/openai_agents/workflow.py`
- `sandbox/_temporal_sandbox_client.py`: `https://github.com/temporalio/sdk-python/blob/447472e51f8c39c3a4e5cee08c524d72d09a774c/temporalio/contrib/openai_agents/sandbox/_temporal_sandbox_client.py`
- `sandbox/_temporal_sandbox_session.py`: `https://github.com/temporalio/sdk-python/blob/447472e51f8c39c3a4e5cee08c524d72d09a774c/temporalio/contrib/openai_agents/sandbox/_temporal_sandbox_session.py`
- `sandbox/_sandbox_client_provider.py`: `https://github.com/temporalio/sdk-python/blob/447472e51f8c39c3a4e5cee08c524d72d09a774c/temporalio/contrib/openai_agents/sandbox/_sandbox_client_provider.py`

## Status

Temporal's blog says the OpenAI Agents SDK integration became generally available on 2026-03-23. Source: `https://temporal.io/blog/announcing-openai-agents-sdk-integration`.

The Temporal SDK README labels sandbox support as pre-release. Treat the overall Temporal integration and the sandbox-specific extension as separate status claims. Source: `https://github.com/temporalio/sdk-python/blob/447472e51f8c39c3a4e5cee08c524d72d09a774c/temporalio/contrib/openai_agents/README.md`.

The Temporal samples README still says "Public Preview" at commit `29fc4af7c1f350a30cd1d45b8ead4b3c9494aec4`, which conflicts with the newer blog's GA statement. Treat samples as examples that may lag status wording. Source: `https://github.com/temporalio/samples-python/tree/29fc4af7c1f350a30cd1d45b8ead4b3c9494aec4/openai_agents`.

## What Temporal Adds

Temporal adds durable execution around Agents SDK orchestration. Model calls, activity tools, MCP calls, and sandbox operations can be routed through Temporal workflow/activity boundaries so progress can survive retries, worker failures, and delayed human work. Sources: `https://temporal.io/blog/announcing-openai-agents-sdk-integration`, `https://github.com/temporalio/sdk-python/blob/447472e51f8c39c3a4e5cee08c524d72d09a774c/temporalio/contrib/openai_agents/README.md`.

Temporal does not make every external system durable by itself. The README says Temporal durability does not extend to MCP servers; MCP servers need their own durability. Source: `https://github.com/temporalio/sdk-python/blob/447472e51f8c39c3a4e5cee08c524d72d09a774c/temporalio/contrib/openai_agents/README.md`.

## Plugin Architecture

`OpenAIAgentsPlugin` configures data conversion, tracing interceptors, model execution activity, MCP server activities, sandbox activities, runtime overrides, and Temporal workflow sandbox passthrough modules. Source: `https://github.com/temporalio/sdk-python/blob/447472e51f8c39c3a4e5cee08c524d72d09a774c/temporalio/contrib/openai_agents/_temporal_openai_agents.py`.

The default model activity uses `OpenAIProvider(AsyncOpenAI(max_retries=0))` so Temporal activity retry policy controls retries instead of the OpenAI client retry loop. Source: `https://github.com/temporalio/sdk-python/blob/447472e51f8c39c3a4e5cee08c524d72d09a774c/temporalio/contrib/openai_agents/_invoke_model_activity.py`.

The Temporal runner recursively replaces Agents SDK model surfaces with a Temporal model stub, including handoff agents, so model calls execute as activities. Source: `https://github.com/temporalio/sdk-python/blob/447472e51f8c39c3a4e5cee08c524d72d09a774c/temporalio/contrib/openai_agents/_openai_runner.py`.

## Workflow Rules

Use `activity_as_tool` to wrap Temporal activities as Agents SDK tools. Bare callable tools are rejected in the Temporal workflow runner path unless they are Temporal activities; pure deterministic non-I/O functions may use normal function tools if they obey workflow restrictions. Sources: `https://github.com/temporalio/sdk-python/blob/447472e51f8c39c3a4e5cee08c524d72d09a774c/temporalio/contrib/openai_agents/README.md`, `https://github.com/temporalio/sdk-python/blob/447472e51f8c39c3a4e5cee08c524d72d09a774c/temporalio/contrib/openai_agents/workflow.py`, `https://github.com/temporalio/sdk-python/blob/447472e51f8c39c3a4e5cee08c524d72d09a774c/temporalio/contrib/openai_agents/_openai_runner.py`.

Activity tools receive a copy of context and cannot persist context mutations back to workflow context. Function tools running in the workflow can mutate context if they remain deterministic and workflow-safe. Source: `https://github.com/temporalio/sdk-python/blob/447472e51f8c39c3a4e5cee08c524d72d09a774c/temporalio/contrib/openai_agents/README.md`.

Unsupported workflow path features include `run_sync`, `run_streamed`, `SQLiteSession`, raw callable tools in workflows, non-Temporal MCP servers, and raw sandbox clients inside workflows. Source: `https://github.com/temporalio/sdk-python/blob/447472e51f8c39c3a4e5cee08c524d72d09a774c/temporalio/contrib/openai_agents/_openai_runner.py`.

## Sandbox Support In Temporal

The Temporal README says sandbox support lets `SandboxAgent` execute in local or remote sandbox backends while Temporal coordinates the durable workflow. Every sandbox operation, including session creation, command execution, and file I/O, is dispatched as a Temporal activity, and sandbox session state is serialized into workflow state. Source: `https://github.com/temporalio/sdk-python/blob/447472e51f8c39c3a4e5cee08c524d72d09a774c/temporalio/contrib/openai_agents/README.md`.

Workflow code must use `temporal_sandbox_client("provider-name")`, not a raw sandbox client. The provider name must match the `SandboxClientProvider` registered on the worker through `OpenAIAgentsPlugin`. Sources: `https://github.com/temporalio/sdk-python/blob/447472e51f8c39c3a4e5cee08c524d72d09a774c/temporalio/contrib/openai_agents/workflow.py`, `https://github.com/temporalio/sdk-python/blob/447472e51f8c39c3a4e5cee08c524d72d09a774c/temporalio/contrib/openai_agents/sandbox/_sandbox_client_provider.py`.

`TemporalSandboxClient` is workflow-side and serializable. It performs create, resume, and delete by executing Temporal activities, and its default activity config uses a five-minute start-to-close timeout. Source: `https://github.com/temporalio/sdk-python/blob/447472e51f8c39c3a4e5cee08c524d72d09a774c/temporalio/contrib/openai_agents/sandbox/_temporal_sandbox_client.py`.

`TemporalSandboxSession` holds serializable sandbox state and routes operations such as `exec`, file reads/writes, PTY interactions, start, stop, shutdown, persist, and hydrate through provider-prefixed Temporal activities. Source: `https://github.com/temporalio/sdk-python/blob/447472e51f8c39c3a4e5cee08c524d72d09a774c/temporalio/contrib/openai_agents/sandbox/_temporal_sandbox_session.py`.

## Support Matrix

The Temporal README says OpenAI and LiteLLM model providers are supported, while streaming and voice are not supported. It lists `FunctionTool`, `WebSearchTool`, `FileSearchTool`, `HostedMCPTool`, `ImageGenerationTool`, and `CodeInterpreterTool` as supported; `LocalShellTool` and `ComputerTool` are not supported. Source: `https://github.com/temporalio/sdk-python/blob/447472e51f8c39c3a4e5cee08c524d72d09a774c/temporalio/contrib/openai_agents/README.md`.

OpenAI platform tracing is supported. OTEL instrumentation is public preview and requires `openinference-instrumentation-openai-agents` and `opentelemetry-sdk`; spans are replay-safe and emitted when workflows complete. Source: `https://github.com/temporalio/sdk-python/blob/447472e51f8c39c3a4e5cee08c524d72d09a774c/temporalio/contrib/openai_agents/README.md`.

## Integration Pattern

1. Put orchestration in a Temporal workflow.
2. Configure the worker with `OpenAIAgentsPlugin`.
3. Wrap side-effecting or I/O tools with `activity_as_tool`.
4. Use `temporal_sandbox_client(name)` in `SandboxRunConfig` for sandbox agents.
5. Register matching `SandboxClientProvider(name, real_client)` on the worker.
6. Keep non-deterministic I/O out of workflow code unless routed through activities.

For cross-layer durability, still persist application-level identifiers, artifact references, and version markers as described in `storage-adapters-and-sessions.md` and `blob-and-artifact-storage.md`.
