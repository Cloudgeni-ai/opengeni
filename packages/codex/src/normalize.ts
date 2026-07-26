// Pure request-body + model-slug transforms for the ChatGPT/Codex backend.
//
// Per the verified NORMALIZATION VERDICT (CODEX-IMPL-PACKET §0), against our
// @openai/agents stack we do EXACTLY this and no more:
//   - force store:false
//   - union include with reasoning.encrypted_content
//   - strip max_output_tokens / max_completion_tokens
//   - reasoning effort minimal -> low
//   - normalize the model slug (longest-prefix against the live catalog)
//   - strip every item `id` but PRESERVE `call_id`
// We do NOT filter item_reference (the SDK never emits it) and do NOT convert
// orphaned tool outputs (the SDK's runner already prunes by call_id).

const MINIMAL = "minimal";

// The ChatGPT/Codex backend is a STRICT ALLOWLIST: it 400s on ANY top-level field
// the Codex CLI itself does not send (confirmed live against the backend —
// "Unsupported parameter: temperature / top_p / metadata / previous_response_id /
// logprobs / service_tier / user / safety_identifier / truncation / max_tool_calls /
// background / conversation", and "Unsupported tool type: mcp"). Our @openai/agents
// stack adds several of these, so after our transforms we keep ONLY the codex
// Responses payload fields (CODEX-SUBSCRIPTION-SPEC §1 field table).
const CODEX_ALLOWED_TOP_LEVEL_KEYS = new Set<string>([
  "model",
  "instructions",
  "input",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "store",
  "stream",
  "include",
  "prompt_cache_key",
  "text",
]);

/** Mutates a parsed Responses request body in place and returns it. Pure + synchronous + unit-testable. */
export function normalizeCodexRequestBody(
  body: Record<string, unknown>,
  resolveModel: (slug: string) => string,
): Record<string, unknown> {
  body.store = false; // ChatGPT backend REQUIRES store=false (spec §1.3)
  body.stream = true; // ChatGPT backend REQUIRES stream=true (confirmed live: 400 "Stream must be set to true").

  // include MUST contain reasoning.encrypted_content (stateless continuity, spec §1.6)
  const include = Array.isArray(body.include)
    ? (body.include as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  if (!include.includes("reasoning.encrypted_content")) {
    include.push("reasoning.encrypted_content");
  }
  body.include = include;

  // reasoning effort: minimal -> low (backend rejects minimal). spec §1.5
  const reasoning = body.reasoning as { effort?: string } | null | undefined;
  if (reasoning && reasoning.effort === MINIMAL) {
    reasoning.effort = "low";
  }

  // model slug: longest-prefix against the live catalog. spec §1.4
  if (typeof body.model === "string") {
    body.model = resolveModel(body.model);
  }

  // strip every item id; PRESERVE call_id. spec §1.6 / verdict §0(b)
  // (This also covers tool_search items: the backend accepts an id-less
  // tool_search_call/output pair correlated by call_id — verified live — and
  // stripping the account-bound `tsc_…` id here sanitizes BOTH replay paths.)
  if (Array.isArray(body.input)) {
    for (const item of body.input as unknown[]) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const record = item as Record<string, unknown>;
      if ("id" in record) {
        delete record.id;
      }
      // A replayed tool_search_call must carry `arguments` as an OBJECT — the
      // backend 400s a string ("Invalid type for 'input[N].arguments': expected
      // an object", verified live). The live wire emits an object (the SDK's
      // protocol schema is z.unknown() and round-trips it), so this only fires
      // for a defensively-stringified row; unparseable strings fall back to {}.
      if (record.type === "tool_search_call" && typeof record.arguments === "string") {
        try {
          const parsed = JSON.parse(record.arguments) as unknown;
          record.arguments = parsed && typeof parsed === "object" ? parsed : {};
        } catch {
          record.arguments = {};
        }
      }
    }
  }

  // Drop hosted-MCP tool entries: the backend rejects them ("Unsupported tool
  // type: mcp"). OpenGeni's MCP servers are client-connected, so their tools
  // already arrive as `function` tools — this only sheds a stray `mcp` entry.
  if (Array.isArray(body.tools)) {
    body.tools = (body.tools as unknown[]).filter(
      (t) => !(t && typeof t === "object" && (t as Record<string, unknown>).type === "mcp"),
    );
  }

  // Final allowlist: shed every other top-level field our @openai/agents stack
  // may have added (temperature, top_p, metadata, previous_response_id,
  // max_output_tokens, truncation, …) so the strict backend does not 400.
  for (const key of Object.keys(body)) {
    if (!CODEX_ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      delete body[key];
    }
  }
  return body;
}

/**
 * Build a longest-prefix model resolver. Catalog slugs come from GET /models
 * (api-client.ts). One leading `namespace/` segment is stripped first; an
 * unknown slug returns the fallback (caller should log — spec §1.4 step 4).
 */
export function buildModelResolver(
  liveSlugs: readonly string[],
  fallbackSlug: string,
): (slug: string) => string {
  return (requested: string): string => {
    const stripped = requested.includes("/")
      ? requested.slice(requested.indexOf("/") + 1)
      : requested;
    let best = "";
    for (const slug of liveSlugs) {
      if (stripped.startsWith(slug) && slug.length > best.length) {
        best = slug;
      }
    }
    return best || fallbackSlug;
  };
}
