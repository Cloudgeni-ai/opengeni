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

/** Mutates a parsed Responses request body in place and returns it. Pure + synchronous + unit-testable. */
export function normalizeCodexRequestBody(
  body: Record<string, unknown>,
  resolveModel: (slug: string) => string,
): Record<string, unknown> {
  body.store = false; // ChatGPT backend REQUIRES store=false (spec §1.3)
  body.stream = true; // ChatGPT backend REQUIRES stream=true (confirmed live: 400 "Stream must be set to true").
  delete body.max_output_tokens; // rejected -> strip (spec §1.3)
  delete body.max_completion_tokens;

  // include MUST contain reasoning.encrypted_content (stateless continuity, spec §1.6)
  const include = Array.isArray(body.include) ? (body.include as unknown[]).filter((v): v is string => typeof v === "string") : [];
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
  if (Array.isArray(body.input)) {
    for (const item of body.input as unknown[]) {
      if (item && typeof item === "object" && "id" in item) {
        delete (item as Record<string, unknown>).id;
      }
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
    const stripped = requested.includes("/") ? requested.slice(requested.indexOf("/") + 1) : requested;
    let best = "";
    for (const slug of liveSlugs) {
      if (stripped.startsWith(slug) && slug.length > best.length) {
        best = slug;
      }
    }
    return best || fallbackSlug;
  };
}
