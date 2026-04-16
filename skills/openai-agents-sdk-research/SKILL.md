---
name: openai-agents-sdk-research
description: Use when researching, evaluating, or implementing OpenAI Agents SDK workflows, especially sandbox agents, Temporal integration, storage adapters, conversation state, RunState resume, sandbox/session/snapshot state, blob or artifact storage, Python SDK internals, Python versus TypeScript support, source provenance, currentness, and open gaps.
---

# OpenAI Agents SDK Research

## Overview

This skill is a source-grounded field guide for OpenAI Agents SDK architecture and implementation questions. It consolidates the SDK ecosystem, Python internals, Sandbox Agents, Temporal durability, session/storage adapters, conversation and run-state resume, sandbox state, artifacts/blobs, and known gaps.

Use it before making claims about what the SDK supports, choosing a persistence strategy, designing a sandbox-backed workflow, wiring Temporal into an agent system, or explaining Python/TypeScript differences.

## Evidence Rules

Use the strongest source available:

1. Official docs, official SDK source, package registries, release tags.
2. Official blogs, official examples, merged PRs, commits, release notes.
3. Open issues, community demos, and source-audit notes.

Every important claim should cite a URL, commit-pinned source path, package registry, or a named reference file in this skill. If the user asks for "latest", current production guidance, migration guidance, package versions, pricing, model selection, or availability, re-check official OpenAI and Temporal sources before answering.

## Research Workflow

1. Identify the question area: ecosystem, Python internals, sandbox/state, Temporal, storage/session state, artifacts/blobs, source provenance, or gaps.
2. Load only the matching reference file from the map below.
3. Check `references/sources-index.md` when trust level, version, source freshness, or conflict resolution matters.
4. Separate confirmed facts, source-backed inferences, stale/conflicting source wording, and open gaps.
5. Answer with implementation implications, not just API names.

## Reference Map

- `references/retrieval-guide.md`: route questions to files, refresh currentness, and keep terminology distinct.
- `references/overview.md`: ecosystem snapshot, language split, mental model, and durable architecture summary.
- `references/python-sdk-internals.md`: Python SDK run loop, model/tool/session/run-state/sandbox control flow, userland versus remote boundaries, and performance caveats.
- `references/sandbox-agents-and-state.md`: Sandbox Agents, clients, capabilities, manifests, sessions, snapshots, mounts, memory, and hosted shell comparison.
- `references/temporal-integration.md`: Temporal plugin, workflow restrictions, sandbox support, support matrix, and observability.
- `references/storage-adapters-and-sessions.md`: Python/TypeScript session contracts, adapters, continuation choices, `RunState`, approvals, streaming, compaction, and adapter selection.
- `references/blob-and-artifact-storage.md`: large files, OpenAI file references, sandbox workspace artifacts, snapshots, mounts, and artifact indexing.
- `references/sources-index.md`: canonical sources, trust levels, source commits, package versions, and provenance of the merged research inputs.
- `references/open-questions.md`: unresolved gaps, conflicts, and caveats to surface in production guidance.

## Common Routes

For "What does the SDK support today?", load `overview.md` and `sources-index.md`.

For "How does the Python SDK actually run agents/tools/handoffs?", load `python-sdk-internals.md`.

For "Should I use Sandbox Agents, hosted shell, or a normal tool?", load `sandbox-agents-and-state.md`.

For "How do I make this workflow durable?", load `temporal-integration.md` and `storage-adapters-and-sessions.md`.

For "Where should state or files live?", load `storage-adapters-and-sessions.md`, `sandbox-agents-and-state.md`, and `blob-and-artifact-storage.md`.

For "What is risky or unknown?", load `open-questions.md` before recommending an architecture.
