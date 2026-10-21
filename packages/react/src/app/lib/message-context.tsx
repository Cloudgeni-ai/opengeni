// Context the page adds to each new chat and message, such as where the person
// is writing from or what they have selected. An item with a label shows as a
// pill above the composer, and the person can leave it out of their next
// messages; an item without a label is sent quietly with every message.

/** One piece of per-message context. Context for the model, never instructions. */
export type MessageContextItem = Readonly<{
  /** Stable identity, such as "selection"; leaving an item out is remembered per id and label. */
  id: string;
  /** The text the model receives with each message. */
  text: string;
  /** Short pill text, such as "Sheet1 · B2:D14". Without one, the item is sent but not shown. */
  label?: string | undefined;
  /** Longer description in the pill's tooltip. */
  detail?: string | undefined;
}>;

/**
 * What a page supplies: plain text, one item, a list of items, or a function
 * read when each message is sent (not shown in the composer).
 */
export type MessageContextInput =
  | string
  | MessageContextItem
  | readonly MessageContextItem[]
  | (() => string | undefined)
  | undefined;

export type MessageContextPill = Readonly<{
  id: string;
  label: string;
  detail?: string | undefined;
  /** The person left this out of their messages. */
  excluded: boolean;
}>;

export type MessageContextStore = Readonly<{
  set(input: MessageContextInput): void;
  /** The pills to show, stable between changes (for useSyncExternalStore). */
  pills(): readonly MessageContextPill[];
  subscribe(listener: () => void): () => void;
  exclude(id: string): void;
  include(id: string): void;
  /** The context text to send with a message now, without excluded items. */
  forSend(): string | undefined;
}>;

function itemsOf(input: MessageContextInput): readonly MessageContextItem[] {
  if (input === undefined || typeof input === "function") return [];
  if (typeof input === "string") return input.trim() ? [{ id: "context", text: input }] : [];
  const list: readonly MessageContextItem[] = Array.isArray(input)
    ? (input as readonly MessageContextItem[])
    : [input as MessageContextItem];
  return list.filter((item) => item.text.trim().length > 0);
}

function exclusionKey(item: Pick<MessageContextItem, "id" | "label">): string {
  return `${item.id}\u0000${item.label ?? ""}`;
}

function samePills(a: readonly MessageContextPill[], b: readonly MessageContextPill[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (pill, index) =>
        pill.id === b[index]!.id &&
        pill.label === b[index]!.label &&
        pill.detail === b[index]!.detail &&
        pill.excluded === b[index]!.excluded,
    )
  );
}

export function createMessageContextStore(initial?: MessageContextInput): MessageContextStore {
  let input: MessageContextInput = initial;
  // Leaving a pill out lasts while it shows the same label: a new selection
  // brings the context back.
  const excluded = new Set<string>();
  const listeners = new Set<() => void>();
  let pills: readonly MessageContextPill[] = [];

  function recompute(): void {
    const items = itemsOf(input);
    const live = new Set(items.map(exclusionKey));
    for (const key of excluded) if (!live.has(key)) excluded.delete(key);
    const next = items.flatMap((item): MessageContextPill[] =>
      item.label
        ? [
            {
              id: item.id,
              label: item.label,
              ...(item.detail ? { detail: item.detail } : {}),
              excluded: excluded.has(exclusionKey(item)),
            },
          ]
        : [],
    );
    if (samePills(pills, next)) return;
    pills = next;
    for (const listener of listeners) listener();
  }

  function toggle(id: string, exclude: boolean): void {
    const item = itemsOf(input).find((candidate) => candidate.id === id && candidate.label);
    if (!item) return;
    if (exclude) excluded.add(exclusionKey(item));
    else excluded.delete(exclusionKey(item));
    recompute();
  }

  recompute();
  return {
    set(next) {
      input = next;
      recompute();
    },
    pills: () => pills,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    exclude: (id) => toggle(id, true),
    include: (id) => toggle(id, false),
    forSend() {
      if (typeof input === "function") return input()?.trim() || undefined;
      const text = itemsOf(input)
        .filter((item) => !excluded.has(exclusionKey(item)))
        .map((item) => item.text.trim())
        .join("\n\n");
      return text || undefined;
    },
  };
}
