# Image generation

Image generation is a provider-aware agent tool with one provider-neutral
artifact contract. Providers create pixels; OpenGeni owns durable operation
admission, validation, storage, model-history projection, sandbox
materialization, API retrieval, and timeline rendering.

Canonical sources:

- tool contract: `packages/contracts/src/image-generation.ts`
- provider selection and turn integration:
  `apps/worker/src/activities/agent-turn.ts`
- media validation, retention, and model projections:
  `apps/worker/src/activities/generated-images.ts`
- adapter operation fence:
  `apps/worker/src/activities/image-generation-operation.ts`
- bounded provider wire decoding: `packages/network/src/json-base64.ts`
- database authority: `packages/db/src/generated-images.ts` and migration
  `0187_generated_image_artifacts.sql`
- public retrieval: `apps/api/src/routes/files.ts`,
  `packages/sdk/src/retained-artifacts.ts`, and the React timeline registry

## Provider selection

Selection is deterministic for the accepted turn:

1. A first-party, direct OpenAI Responses turn whose selected text model
   explicitly declares hosted image generation uses the native
   `image_generation` tool with `gpt-image-2`. A custom OpenAI-compatible base
   URL and unknown model capability both fail closed.
2. A connected Codex subscription uses its account-scoped image endpoint with
   `gpt-image-2` through a client-executed function tool.
3. Other model routes may use the workspace-owned Vercel AI Gateway credential
   through the pinned Gateway image-model protocol;
   `OPENGENI_IMAGE_GENERATION_MODEL` selects that image model and defaults to
   `openai/gpt-image-2`.

The ordinary text model and image model are intentionally independent. The
tool is omitted unless permanent object storage and one verified route above
are available. Generation currently accepts one bounded text prompt and
returns one image. Editing, masks, and reference-image inputs are not silently
emulated.

The selected text provider does not change the generated-image artifact or UI
contract. Current route availability is:

| Text-model route | Generation transport | Existing image/view input |
| --- | --- | --- |
| Direct reviewed OpenAI Responses | Native hosted tool | Typed Responses image input |
| Connected Codex subscription | Codex image adapter | Typed function-image results |
| Managed or workspace Gateway Responses | Workspace Gateway image adapter | Typed image input only for catalogued vision models |
| Other registry Responses providers | Workspace Gateway image adapter | Typed image input only when the model declares it |
| Registry Chat providers | Workspace Gateway image adapter | Disabled until OpenGeni has a proven typed Chat image wire |

“Workspace Gateway image adapter” requires that workspace's Gateway key; the
managed OpenGeni text-model credential is not reused for separately billed
image generation. Text-only models can still create images through the adapter,
but never receive pixel-bearing `view_image` or computer tools.

## Durable operation and artifact boundary

Adapter-backed generation is a paid, side-effecting operation. Before calling
the provider, the worker prepares one stable `image_generation_operations` row
keyed by workspace, logical turn, and tool-call identity, then advances it to
`provider_started`. A recovery may complete a deterministic object upload that
already exists, but never repeats a provider call after that transition. An
ambiguous provider outcome remains `outcome_unknown`.

Native hosted generation remains part of the provider model call and therefore
inherits the existing single-in-flight-model-step crash boundary. Its provider
item id, provider binding, and workspace identify the retained artifact.

Successful bytes are signature-, dimension-, size-, MIME-, and SHA-256-checked
before they become a permanent workspace `files` row. The
`generated_image_artifacts` row records only bounded correlation and exact
media facts. Object keys, credentials, signed URLs, and base64 never enter the
receipt. A ready receipt is immutable and retrieves through the existing
workspace artifact/file authority.

JSON/base64 provider responses are decoded incrementally into one bounded byte
buffer. OpenGeni never retains the full JSON envelope or encoded image string,
and provider adapters never retry an outcome-ambiguous paid request.

## Conversation and prompt-cache invariants

Generated pixels are artifacts, not conversation memory.

- Native base64 is retained before any event/history serialization and is
  replaced durably by one closed `generated_image` receipt.
- Function adapters return that same compact receipt directly.
- Every later model request projects a retained native hosted item to one
  deterministic assistant fact containing only artifact id, sandbox path, MIME,
  and dimensions. Adapter history remains its provider-neutral `generate_image`
  call plus the same compact receipt. Neither path receives a signed URL,
  provider item id, object key, or historical base64.
- A requires-action `RunState` stores the compact receipt. Its SDK-resume view
  temporarily projects the native hosted item to the same assistant fact;
  durable state is not rewritten during resume.
- These request-local projections preserve canonical item order and are stable
  for an unchanged history prefix.

## Sandbox and browser delivery

After retention, the worker materializes the exact file at
`/workspace/generated-images/generated-image-<artifact-id>.<ext>` whenever the
turn has a sandbox. The object write is already durable, so a transient sandbox
copy failure cannot replay generation; the missing materialization is retried
from the receipt on a later turn.

Browsers receive only the compact receipt in the timeline. The SDK validates
its closed shape and either verifies bounded range downloads or mints a
short-lived file download URL. The stock React renderer uses the signed URL so
multi-megabyte images do not make a second full JavaScript byte copy.

Filesystem `view_image` and computer screenshots use the separate
session-retained-image lifecycle. PNG, JPEG, and WebP are signature-validated,
stored without inline base64, and rendered through authenticated artifact
retrieval. Other SDK-recognized image formats are not promoted to that durable
contract; they remain unsupported rather than being silently transcoded or sent
to providers whose accepted MIME set is unknown.
