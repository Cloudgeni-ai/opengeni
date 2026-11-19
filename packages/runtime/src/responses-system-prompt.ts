import type { ModelJsonRequestPolicy } from "./replayable-json-body";

/**
 * Send the agent's system prompt as the first `input` item, a developer
 * message, instead of the top-level Responses `instructions` field.
 *
 * From GPT-6.2 on, OpenAI places top-level `instructions` after `input`,
 * outside every prompt-cache prefix, and bills them as uncached input on every
 * request. OpenAI's GPT-6.2 guide says to put reusable instructions in a
 * developer message as the first input item and to keep `instructions` for
 * guidance that applies to one request only. Opengeni's system prompt is
 * stable for a chat, so it belongs in the cached prefix. Earlier models cache
 * both shapes, so one shape serves every model.
 *
 * The item is derived from the request alone, so it is byte-identical on
 * every request of a chat and never enters stored history. Requests that
 * point at provider-stored state (`previous_response_id`, `conversation`)
 * keep `instructions`, which the provider does not carry between responses.
 * Returns the projected body, or null when nothing changes.
 */
export function cacheableSystemPromptBody(
  path: string,
  body: Readonly<Record<string, unknown>>,
): Record<string, unknown> | null {
  if (!(path.split("?", 1)[0] ?? path).endsWith("/responses")) return null;
  const instructions = body.instructions;
  if (typeof instructions !== "string" || !instructions.trim()) return null;
  if (body.previous_response_id != null || body.conversation != null) return null;
  const input =
    typeof body.input === "string"
      ? [{ type: "message", role: "user", content: body.input }]
      : Array.isArray(body.input)
        ? body.input
        : null;
  if (!input) return null;
  const { instructions: _moved, ...rest } = body;
  return {
    ...rest,
    input: [{ type: "message", role: "developer", content: instructions }, ...input],
  };
}

/** Applies {@link cacheableSystemPromptBody} after another policy's projection. */
export function withCacheableSystemPrompt(policy: ModelJsonRequestPolicy): ModelJsonRequestPolicy {
  return (request) => {
    const result = policy(request);
    const body = cacheableSystemPromptBody(request.path, result?.body ?? request.body);
    return body ? { ...result, body } : result;
  };
}
