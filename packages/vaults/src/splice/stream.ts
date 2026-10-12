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

/** Allocates one env binding per distinct reference and one sentinel per literal use. */
export class BindingTable {
  readonly bindings: SpliceBinding[] = [];
  private readonly byKey = new Map<string, SpliceBinding>();
  private readonly nonce: string;

  constructor(
    private readonly envPrefix: string,
    nonce?: string,
  ) {
    this.nonce = nonce ?? crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  }

  private allocate(reference: SecretReference, literal: boolean): SpliceBinding {
    const key = referenceKey(reference);
    const tableKey = `${literal ? "L" : "E"}|${key}`;
    const existing = this.byKey.get(tableKey);
    if (existing) return existing;
    const index = this.bindings.length;
    const binding: SpliceBinding = {
      envName: `${this.envPrefix}${index}`,
      key,
      literal,
      sentinel: literal ? `@@OGSECRET_${this.nonce}_${index}@@` : null,
    };
    this.byKey.set(tableKey, binding);
    this.bindings.push(binding);
    return binding;
  }

  env(reference: SecretReference): string {
    return this.allocate(reference, false).envName;
  }

  sentinel(reference: SecretReference): string {
    return this.allocate(reference, true).sentinel!;
  }
}
