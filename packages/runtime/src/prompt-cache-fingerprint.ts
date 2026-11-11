import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, type Hash } from "node:crypto";
import {
  PROMPT_CACHE_DIGEST_HEX_LENGTH,
  type PromptCacheRequestFingerprint,
} from "@opengeni/contracts";

/**
 * Wire fingerprints of provider requests, for prompt-cache diagnostics.
 *
 * The fingerprint is taken from the exact request body the transport sends,
 * so it sees every projection, restoration and provider conversion. It covers
 * the parts a prompt cache keys on, in order: tools, system prompt, history.
 * Cache markers move between requests by design and Claude's per-request
 * billing metadata block does not bind the cache, so both are excluded.
 */

const BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";

type FingerprintObserver = (fingerprint: Promise<PromptCacheRequestFingerprint | null>) => void;
const observers = new AsyncLocalStorage<FingerprintObserver>();

/** Receive the wire fingerprint of every model request sent inside `callback`. */
export function withPromptCacheFingerprintObserver<T>(
  observer: FingerprintObserver | undefined,
  callback: () => T,
): T {
  return observer ? observers.run(observer, callback) : callback();
}

/**
 * Called by the model transport with the final body. Fingerprinting parses
 * the body, so it runs after dispatch and never delays the request.
 */
export function observePromptCacheRequestBody(body: unknown): void {
  const observer = observers.getStore();
  if (!observer || typeof body !== "string") return;
  try {
    observer(
      new Promise((resolve) => {
        setImmediate(() => {
          try {
            resolve(promptCacheRequestFingerprint(JSON.parse(body)));
          } catch {
            resolve(null);
          }
        });
      }),
    );
  } catch {
    // Diagnostics never affect model dispatch.
  }
}

function digest(hash: Hash): string {
  return hash.digest("hex").slice(0, PROMPT_CACHE_DIGEST_HEX_LENGTH);
}

function withoutCacheMarkers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheMarkers);
  if (!value || typeof value !== "object") return value;
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "cache_control") continue;
    copy[key] = withoutCacheMarkers(entry);
  }
  return copy;
}

function canonical(value: unknown): string {
  return JSON.stringify(withoutCacheMarkers(value)) ?? "null";
}

function isBillingBlock(block: unknown): boolean {
  const text = (block as { text?: unknown } | null)?.text;
  return typeof text === "string" && text.startsWith(BILLING_HEADER_PREFIX);
}

/**
 * Claude caches content blocks in order, and a message may legitimately grow
 * between requests (tool results and the next user text merge into one user
 * message). Each block, tagged with its role, is therefore one history unit.
 * Chat Completions content parts follow the same rule.
 */
function messageHistoryUnits(messages: unknown[]): unknown[] {
  return messages.flatMap((message) => {
    const { role, content } = (message ?? {}) as { role?: unknown; content?: unknown };
    return Array.isArray(content)
      ? content.map((block) => ({ role, block }))
      : [{ role, block: content }];
  });
}

/**
 * Fingerprint a parsed provider request body. Supports Claude Messages
 * (`system` + `messages`), Responses (`instructions` + `input`) and Chat
 * Completions (`messages`). Returns null for any other shape. History units
 * are message content blocks (Claude, Chat) or Responses input items.
 */
export function promptCacheRequestFingerprint(body: unknown): PromptCacheRequestFingerprint | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const history = Array.isArray(record.messages)
    ? messageHistoryUnits(record.messages)
    : Array.isArray(record.input)
      ? record.input
      : typeof record.input === "string"
        ? [record.input]
        : null;
  if (!history) return null;
  const system = Array.isArray(record.system)
    ? record.system.filter((block) => !isBillingBlock(block))
    : typeof record.system === "string"
      ? record.system.startsWith(BILLING_HEADER_PREFIX)
        ? ""
        : record.system
      : (record.instructions ?? null);
  const checkpoints: Array<[number, string]> = [];
  const chain = createHash("sha256");
  let next = 1;
  history.forEach((item, index) => {
    chain.update(createHash("sha256").update(canonical(item)).digest());
    const count = index + 1;
    if (count === next || count === history.length) {
      checkpoints.push([count, digest(chain.copy())]);
      if (count === next) next *= 2;
    }
  });
  return {
    v: 1,
    tools: digest(createHash("sha256").update(canonical(record.tools ?? null))),
    system: digest(createHash("sha256").update(canonical(system))),
    items: history.length,
    history: checkpoints,
  };
}
