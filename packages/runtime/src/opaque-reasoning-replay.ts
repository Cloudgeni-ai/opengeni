import { createHash } from "node:crypto";
import { opaqueProviderArtifactFingerprint } from "@opengeni/codex";

/**
 * One replay policy for opaque reasoning state on every provider route.
 *
 * Providers return reasoning they alone can verify: OpenAI-style
 * `encrypted_content`, and Claude's signed `thinking` and `redacted_thinking`
 * blocks. Each such item records the binding it was issued under (its origin,
 * see `withArtifactOrigin`): the provider for encrypted content; the platform,
 * account, model and (for prefix-bound models) the instruction prefix for
 * Claude. A request whose binding differs replays encrypted content as
 * readable historical text (`projectHistoryForProvider` with `artifactScope`)
 * and leaves Claude's own thinking out (its own reasoning shown back to Claude
 * as text can trip Claude's safety systems). Items stored before origins were recorded stay
 * native until the provider refuses them; the refusal is remembered here so
 * the one retry, and every later request in this process, leaves them out
 * (Claude) or sends them as text (encrypted content).
 */

/** Claude's signed thinking block on a reasoning item, when it has one. */
export function claudeSignedThinkingBlock(
  item: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (item.type !== "reasoning") return undefined;
  const metadata = item.providerData as { anthropic?: { block?: unknown } } | undefined;
  const block = metadata?.anthropic?.block;
  return block && typeof block === "object" && claudeThinkingSecret(block as never)
    ? (block as Record<string, unknown>)
    : undefined;
}

/** The signature (or redacted data) that binds a Claude thinking block. */
export function claudeThinkingSecret(block: Record<string, unknown>): string | undefined {
  const secret =
    block?.type === "thinking"
      ? block.signature
      : block?.type === "redacted_thinking"
        ? block.data
        : undefined;
  return typeof secret === "string" && secret.length > 0 ? secret : undefined;
}

/** A content-hiding identity for one signed Claude thinking block. */
export function claudeThinkingFingerprint(block: Record<string, unknown>): string | null {
  const secret = claudeThinkingSecret(block);
  return secret ? `anthropic-thinking:${createHash("sha256").update(secret).digest("hex")}` : null;
}

const fingerprints = new WeakMap<object, string | null>();

/** A content-hiding identity for one item's opaque reasoning state, if any. */
export function opaqueReasoningFingerprint(item: Record<string, unknown>): string | null {
  let fingerprint = fingerprints.get(item);
  if (fingerprint === undefined) {
    const block = claudeSignedThinkingBlock(item);
    fingerprint = block
      ? claudeThinkingFingerprint(block)
      : opaqueProviderArtifactFingerprint(item);
    fingerprints.set(item, fingerprint);
  }
  return fingerprint;
}

/** Bound on remembered refused states per provider (process-local, shared by its sessions). */
const REFUSED_PER_PROVIDER = 16_384;
const refused = new Map<string, Set<string>>();

/** Remember opaque reasoning (by fingerprint) that `providerId` refused. */
export function rememberRefusedOpaqueReasoning(
  providerId: string,
  refusedFingerprints: Iterable<string | null>,
): void {
  let set = refused.get(providerId);
  if (!set) refused.set(providerId, (set = new Set()));
  for (const fingerprint of refusedFingerprints) {
    if (!fingerprint) continue;
    set.delete(fingerprint);
    set.add(fingerprint);
    if (set.size > REFUSED_PER_PROVIDER) set.delete(set.values().next().value as string);
  }
}

/** Whether `providerId` already refused this opaque reasoning (by fingerprint). */
export function refusedOpaqueReasoning(
  providerId: string,
): ((fingerprint: string | null) => boolean) | undefined {
  const set = refused.get(providerId);
  return set?.size ? (fingerprint) => fingerprint !== null && set.has(fingerprint) : undefined;
}

/** The `isRejectedArtifact` option of `projectHistoryForProvider` for `providerId`. */
export function rejectedOpaqueReasoningFilter(
  providerId: string,
): ((item: Record<string, unknown>) => boolean) | undefined {
  const isRefused = refusedOpaqueReasoning(providerId);
  return isRefused ? (item) => isRefused(opaqueReasoningFingerprint(item)) : undefined;
}

/** Test isolation only. */
export function clearRefusedOpaqueReasoning(): void {
  refused.clear();
}
