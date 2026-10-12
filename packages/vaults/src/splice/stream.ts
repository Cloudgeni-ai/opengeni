/**
 * The splice scanners walk one virtual stream in which literal text is split
 * into characters (code points) and each secret reference is one opaque item.
 * References never take part in shell lexing: the scanner only asks "which
 * lexical context am I in?" when it meets one.
 */
import { referenceKey, type SecretReference, type SecretTextToken } from "@opengeni/contracts";

export type StreamItem = string | SecretReference;

export function isReference(item: StreamItem | undefined): item is SecretReference {
  return typeof item === "object" && item !== null;
}

/** Literal text keeps escapes removed by the tokenizer; invalid candidates stay verbatim. */
export function streamFromTokens(tokens: readonly SecretTextToken[]): StreamItem[] {
  const items: StreamItem[] = [];
  for (const token of tokens) {
    if (token.type === "reference") {
      items.push(token.reference);
      continue;
    }
    const text = token.type === "text" ? token.value : token.raw;
    for (const character of text) items.push(character);
  }
  return items;
}

export interface SpliceBinding {
  envName: string;
  key: string;
  literal: boolean;
  sentinel: string | null;
}

/**
 * Allocates one env binding per distinct reference (deduplicated by
 * `referenceKey`). Every context is spliced as an expansion, so bindings are
 * never literal; `literal`/`sentinel` remain in the contract for adapters.
 */
export class BindingTable {
  readonly bindings: SpliceBinding[] = [];
  private readonly byKey = new Map<string, SpliceBinding>();

  constructor(private readonly envPrefix: string) {}

  env(reference: SecretReference): string {
    const key = referenceKey(reference);
    const existing = this.byKey.get(key);
    if (existing) return existing.envName;
    const binding: SpliceBinding = {
      envName: `${this.envPrefix}${this.bindings.length}`,
      key,
      literal: false,
      sentinel: null,
    };
    this.byKey.set(key, binding);
    this.bindings.push(binding);
    return binding.envName;
  }
}
