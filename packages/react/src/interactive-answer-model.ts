// Interactive answers: an agent writes a small JSON description of the options
// it found in an `opengeni-ui` fence, and the chat draws it as linked cards, a
// table and a bar chart the person can filter, sort and pick from. Picking
// sends one readable message back into the conversation.
//
// Everything here is renderer-neutral (no DOM, no styles), so the web
// renderer and the React Native renderer parse, filter, order, select and word
// the answer the same way.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createElement } from "react";

/** The fence language an assistant uses for an interactive answer. */
export const INTERACTIVE_ANSWER_FENCE = "opengeni-ui";

/** Bounds that keep an answer readable in a chat column and cheap to draw. */
export const INTERACTIVE_ANSWER_LIMITS = { items: 60, fields: 12, text: 600 } as const;

export type InteractiveAnswerValue = string | number | boolean | null;

export type InteractiveAnswerField = {
  key: string;
  label: string;
  /** Shown with numbers: a currency sign or symbol before ($ € £), anything else after. */
  unit?: string | undefined;
  /** Which end of a numeric field is better; marks the best option. */
  better?: "higher" | "lower" | undefined;
  /** Offer the field's distinct values as filter chips. */
  filter?: boolean | undefined;
};

export type InteractiveAnswerItem = {
  id: string;
  title: string;
  subtitle?: string | undefined;
  description?: string | undefined;
  /** A short highlight such as "Recommended" or "Cheapest". */
  badge?: string | undefined;
  /** An https link to the option. */
  url?: string | undefined;
  values: Record<string, InteractiveAnswerValue>;
};

export type InteractiveAnswerView = "cards" | "table";

export type InteractiveAnswerSpec = {
  title?: string | undefined;
  items: InteractiveAnswerItem[];
  fields: InteractiveAnswerField[];
  /** A numeric field drawn as a bar chart above the options. */
  chart?: string | undefined;
  /** How many options the person may pick and the words of the send button. */
  select?: { max: number; action?: string | undefined } | undefined;
  view: InteractiveAnswerView;
  /** Items beyond the limit that were left out. */
  omitted: number;
};

export type InteractiveAnswerParse =
  | { status: "ok"; spec: InteractiveAnswerSpec }
  /** Still streaming: the options that have fully arrived so far (may be none). */
  | { status: "partial"; spec: InteractiveAnswerSpec | null }
  | { status: "invalid"; reason: "json" | "shape" | "unsupported" };

/**
 * Parse a fence body. With `partial`, an unfinished body (the assistant is
 * still writing it) yields the options that have arrived so far instead of an
 * error, so the answer grows in place while it streams.
 * A body that already parses whole is complete even if its closing fence
 * never arrived (an answer that ended without one), so it can still be picked.
 */
export function parseInteractiveAnswer(
  source: string,
  options: { partial?: boolean | undefined } = {},
): InteractiveAnswerParse {
  let partial = false;
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    if (options.partial !== true) return { status: "invalid", reason: "json" };
    partial = true;
    raw = parsePartialJson(source);
    if (raw === undefined) return { status: "partial", spec: null };
  }
  const result = normalizeSpec(raw, partial);
  if (result.status === "invalid") {
    return options.partial === true ? { status: "partial", spec: null } : result;
  }
  return partial ? { status: "partial", spec: result.spec } : result;
}

/**
 * Whether a message ends inside an unclosed code fence, and that fence's body.
 * Read from the message as written, so renderers that parse a rewritten copy
 * (softened while streaming, math normalized) still know which fence is open.
 */
export function trailingOpenFence(message: string): string | null {
  let open: { char: string; length: number; lines: string[] } | null = null;
  for (const line of message.split("\n")) {
    if (open) {
      const close = /^ {0,3}([`~]{3,})\s*$/.exec(line);
      if (close && close[1]![0] === open.char && close[1]!.length >= open.length) open = null;
      else open.lines.push(line);
      continue;
    }
    const start = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (start) open = { char: start[1]![0]!, length: start[1]!.length, lines: [] };
  }
  return open ? open.lines.join("\n") : null;
}

/**
 * The longest prefix of a streaming JSON text that parses once its open
 * strings, arrays and objects are closed. Cuts back to the last comma or
 * opening bracket when the tail is a half-written key or literal.
 */
export function parsePartialJson(source: string): unknown {
  const cuts: number[] = [];
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === ",") cuts.push(index);
    else if (char === "{" || char === "[") cuts.push(index + 1);
  }
  const candidates = [source.length, ...cuts.reverse()];
  // A long body has many cut points; the last few are always enough.
  for (const end of candidates.slice(0, 64)) {
    // The whole text may end in a number or literal that is still being
    // written (139 of 13990), so it only counts when it ends in a string or
    // bracket. Cuts at a comma or bracket end after a finished value.
    if (end === source.length && /[\w.+-]\s*$/u.test(source) && !inString) continue;
    const closed = closeJson(source.slice(0, end));
    if (closed === null) continue;
    try {
      return JSON.parse(closed);
    } catch {
      // try an earlier cut
    }
  }
  return undefined;
}

function closeJson(prefix: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of prefix) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") stack.push("}");
    else if (char === "[") stack.push("]");
    else if (char === "}" || char === "]") stack.pop();
  }
  if (stack.length === 0 && !inString) return prefix.trim() ? prefix : null;
  let body = prefix;
  if (inString) body = (escaped ? body.slice(0, -1) : body) + '"';
  body = body.trimEnd();
  if (body.endsWith(",")) body = body.slice(0, -1);
  if (body.endsWith(":")) return null;
  return body + stack.reverse().join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number = INTERACTIVE_ANSWER_LIMITS.text): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed;
}

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function cellValue(value: unknown): InteractiveAnswerValue | undefined {
  if (value === null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return text(value, 200) ?? null;
  return undefined;
}

function normalizeSpec(
  raw: unknown,
  partial: boolean,
):
  | { status: "ok"; spec: InteractiveAnswerSpec }
  | { status: "invalid"; reason: "shape" | "unsupported" } {
  if (!isRecord(raw)) return { status: "invalid", reason: "shape" };
  if (raw.type !== undefined && raw.type !== "options") {
    return { status: "invalid", reason: "unsupported" };
  }
  const rawItems = Array.isArray(raw.items) ? raw.items : [];
  const items: InteractiveAnswerItem[] = [];
  const seen = new Set<string>();
  // While streaming, the last item may still be arriving; draw it once it has a title.
  for (const [index, entry] of rawItems.entries()) {
    if (items.length >= INTERACTIVE_ANSWER_LIMITS.items) break;
    if (!isRecord(entry)) continue;
    const title = text(entry.title, 160);
    if (!title) continue;
    let id = text(entry.id, 120) ?? `option-${index + 1}`;
    while (seen.has(id)) id = `${id}-${index + 1}`;
    seen.add(id);
    const values: Record<string, InteractiveAnswerValue> = {};
    if (isRecord(entry.values)) {
      for (const [key, value] of Object.entries(entry.values)) {
        const cell = cellValue(value);
        if (cell !== undefined) values[key] = cell;
      }
    }
    items.push({
      id,
      title,
      subtitle: text(entry.subtitle, 160),
      description: text(entry.description),
      badge: text(entry.badge, 32),
      url: safeUrl(entry.url),
      values,
    });
  }
  if (items.length === 0 && !partial) return { status: "invalid", reason: "shape" };
  const fields: InteractiveAnswerField[] = [];
  const fieldKeys = new Set<string>();
  for (const entry of Array.isArray(raw.fields) ? raw.fields : []) {
    if (fields.length >= INTERACTIVE_ANSWER_LIMITS.fields) break;
    const field = typeof entry === "string" ? { key: entry } : entry;
    if (!isRecord(field)) continue;
    const key = text(field.key, 80);
    if (!key || fieldKeys.has(key)) continue;
    fieldKeys.add(key);
    fields.push({
      key,
      label: text(field.label, 60) ?? key,
      unit: text(field.unit, 12),
      better: field.better === "higher" || field.better === "lower" ? field.better : undefined,
      filter: field.filter === true ? true : undefined,
    });
  }
  const chartKey = text(raw.chart, 80);
  const chart =
    chartKey && fieldKeys.has(chartKey) && items.some((item) => isNumber(item.values[chartKey]))
      ? chartKey
      : undefined;
  let select: InteractiveAnswerSpec["select"];
  if (raw.select === true) select = { max: items.length || 1 };
  else if (isRecord(raw.select)) {
    const max =
      typeof raw.select.max === "number" && raw.select.max >= 1
        ? Math.floor(raw.select.max)
        : Math.max(1, rawItems.length);
    select = { max, action: text(raw.select.action, 48) };
  }
  return {
    status: "ok",
    spec: {
      title: text(raw.title, 160),
      items,
      fields,
      chart,
      select,
      view: raw.view === "table" ? "table" : "cards",
      omitted: Math.max(0, rawItems.length - INTERACTIVE_ANSWER_LIMITS.items),
    },
  };
}

function isNumber(value: InteractiveAnswerValue | undefined): value is number {
  return typeof value === "number";
}

const PREFIX_UNITS = new Set(["$", "€", "£", "¥", "US$"]);

/** A value as text, with its unit. Booleans use the caller's words for yes and no. */
export function formatInteractiveValue(
  field: InteractiveAnswerField | undefined,
  value: InteractiveAnswerValue | undefined,
  words: { yes: string; no: string; empty: string },
  locale?: string,
): string {
  if (value === undefined || value === null || value === "") return words.empty;
  if (typeof value === "boolean") return value ? words.yes : words.no;
  if (typeof value === "string") return value;
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
  const unit = field?.unit;
  if (!unit) return number;
  if (PREFIX_UNITS.has(unit)) return `${unit}${number}`;
  if (unit === "%") return `${number}%`;
  return `${number}\u00a0${unit}`;
}

/** The ids holding the best value of each field that says which end is better. */
export function bestInteractiveItems(
  spec: Pick<InteractiveAnswerSpec, "fields">,
  items: readonly InteractiveAnswerItem[],
): Map<string, Set<string>> {
  const best = new Map<string, Set<string>>();
  if (items.length < 2) return best;
  for (const field of spec.fields) {
    if (!field.better) continue;
    const numbers = items
      .map((item) => item.values[field.key])
      .filter((value): value is number => typeof value === "number");
    if (numbers.length < 2) continue;
    const target = field.better === "higher" ? Math.max(...numbers) : Math.min(...numbers);
    if (numbers.every((value) => value === target)) continue;
    best.set(
      field.key,
      new Set(items.filter((item) => item.values[field.key] === target).map((item) => item.id)),
    );
  }
  return best;
}

/** The distinct values a filter field offers, in the order they first appear. */
export function interactiveFilterOptions(
  field: InteractiveAnswerField,
  items: readonly InteractiveAnswerItem[],
): InteractiveAnswerValue[] {
  const options: InteractiveAnswerValue[] = [];
  for (const item of items) {
    const value = item.values[field.key];
    if (value === undefined || value === null || value === "") continue;
    if (!options.some((option) => option === value)) options.push(value);
  }
  return options.length >= 2 ? options : [];
}

export type InteractiveAnswerSort = { key: string; direction: "asc" | "desc" } | null;

export type InteractiveAnswerState = {
  selected: string[];
  /** The selection the person last sent, so the card can say it was sent. */
  sent: string[] | null;
  view: InteractiveAnswerView | null;
  sort: InteractiveAnswerSort;
  /** Field key to the values shown; a field without an entry shows everything. */
  filters: Record<string, InteractiveAnswerValue[]>;
};

export const EMPTY_INTERACTIVE_ANSWER_STATE: InteractiveAnswerState = {
  selected: [],
  sent: null,
  view: null,
  sort: null,
  filters: {},
};

/**
 * For an answer that stopped mid-stream: leave out a last option that had only
 * its title when the stream ended, so a half-written option doesn't stay on
 * screen as an empty card. Options with any detail are kept.
 */
export function settleInteractiveAnswer(
  parsed: InteractiveAnswerParse,
  state: "complete" | "streaming" | "incomplete",
): InteractiveAnswerParse {
  if (state !== "incomplete" || parsed.status !== "partial" || !parsed.spec) return parsed;
  const spec = parsed.spec;
  const last = spec.items.at(-1);
  if (!last || spec.items.length < 2 || spec.fields.length === 0) return parsed;
  const shown = spec.fields.some((field) => last.values[field.key] !== undefined);
  if (shown || last.subtitle || last.description || last.badge || last.url) return parsed;
  return { status: "partial", spec: { ...spec, items: spec.items.slice(0, -1) } };
}

/** The options shown: filtered, then ordered by the chosen column. */
export function visibleInteractiveItems(
  spec: InteractiveAnswerSpec,
  state: Pick<InteractiveAnswerState, "filters" | "sort">,
): InteractiveAnswerItem[] {
  const filtered = spec.items.filter((item) =>
    Object.entries(state.filters).every(
      ([key, allowed]) => allowed.length === 0 || allowed.includes(item.values[key] ?? null),
    ),
  );
  const sort = state.sort;
  if (!sort) return filtered;
  const factor = sort.direction === "asc" ? 1 : -1;
  const read = (item: InteractiveAnswerItem) =>
    sort.key === "title" ? item.title : item.values[sort.key];
  return filtered
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const left = read(a.item);
      const right = read(b.item);
      const leftEmpty = left === undefined || left === null || left === "";
      const rightEmpty = right === undefined || right === null || right === "";
      // Missing values always sit last, whichever way the column is ordered.
      if (leftEmpty || rightEmpty)
        return leftEmpty === rightEmpty ? a.index - b.index : leftEmpty ? 1 : -1;
      const order =
        typeof left === "number" && typeof right === "number"
          ? left - right
          : String(left).localeCompare(String(right), undefined, { numeric: true });
      return order === 0 ? a.index - b.index : order * factor;
    })
    .map(({ item }) => item);
}

/** The next order for a column: ascending, descending, then back to the agent's order. */
export function nextInteractiveSort(
  current: InteractiveAnswerSort,
  key: string,
  field?: InteractiveAnswerField,
): InteractiveAnswerSort {
  // Start where the better values are, so one tap puts the best option first.
  const first = field?.better === "higher" ? "desc" : "asc";
  if (!current || current.key !== key) return { key, direction: first };
  if (current.direction === first) return { key, direction: first === "asc" ? "desc" : "asc" };
  return null;
}

/** Toggle one option. A single pick replaces; a full multi-pick ignores new ones. */
export function toggleInteractiveSelection(
  selected: readonly string[],
  id: string,
  max: number,
): string[] {
  if (selected.includes(id)) return selected.filter((entry) => entry !== id);
  if (max <= 1) return [id];
  if (selected.length >= max) return [...selected];
  return [...selected, id];
}

/** The send button's words: the agent's own, or the caller's default. */
export function interactiveActionLabel(spec: InteractiveAnswerSpec, fallback: string): string {
  return spec.select?.action ?? fallback;
}

/**
 * The message a pick sends, in the person's voice: the action, then the
 * chosen options by name in the order the agent listed them.
 */
export function interactiveSelectionMessage(
  spec: InteractiveAnswerSpec,
  selected: readonly string[],
  fallbackAction: string,
  locale?: string,
): string {
  const chosen = spec.items.filter((item) => selected.includes(item.id));
  const names = chosen.map((item) => {
    const twin = spec.items.some((other) => other !== item && other.title === item.title);
    return twin && item.subtitle ? `${item.title} (${item.subtitle})` : item.title;
  });
  const action = interactiveActionLabel(spec, fallbackAction).replace(/[\s:.!…]+$/u, "");
  return `${action}: ${joinList(names, locale)}`;
}

function joinList(names: string[], locale?: string): string {
  try {
    return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(names);
  } catch {
    return names.join(", ");
  }
}

/** True when the current pick is exactly what was last sent. */
export function interactiveSelectionWasSent(state: InteractiveAnswerState): boolean {
  return (
    state.sent !== null &&
    state.sent.length === state.selected.length &&
    state.sent.every((id) => state.selected.includes(id))
  );
}

/** A short stable key for one answer body, used to remember its state. */
export function interactiveAnswerKey(source: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36) + source.length.toString(36);
}

/**
 * Where an answer's picks, filters and view are remembered. Synchronous
 * stores (the web's localStorage) restore on first paint; asynchronous ones
 * (a phone's storage) restore as soon as they answer.
 */
export type InteractiveAnswerStore = {
  get: (key: string) => string | null | undefined | Promise<string | null | undefined>;
  set: (key: string, value: string) => void | Promise<void>;
};

export type InteractiveAnswerHost = {
  /**
   * Send the person's pick as their next message (the composer's ordinary
   * Send). Without it, options can still be filtered and compared, but there
   * is no send button.
   */
  send?: ((text: string) => Promise<boolean> | boolean | void) | undefined;
  /** Separates remembered state per conversation (a session id). */
  scope?: string | undefined;
  store?: InteractiveAnswerStore | undefined;
  /** Picks are read-only, for example in a shared or archived conversation. */
  readOnly?: boolean | undefined;
};

const InteractiveAnswerContext = createContext<InteractiveAnswerHost>({});

/** Lets interactive answers in this subtree send picks and remember their state. */
export function InteractiveAnswerProvider({
  children,
  ...host
}: InteractiveAnswerHost & { children?: ReactNode }) {
  const { send, scope, store, readOnly } = host;
  const value = useMemo(() => ({ send, scope, store, readOnly }), [send, scope, store, readOnly]);
  return createElement(InteractiveAnswerContext.Provider, { value }, children);
}

export function useInteractiveAnswerHost(): InteractiveAnswerHost {
  return useContext(InteractiveAnswerContext);
}

const memoryStore = new Map<string, string>();

function storageKey(scope: string | undefined, key: string): string {
  return `og:answer:${scope ?? "-"}:${key}`;
}

function readState(raw: string | null | undefined): InteractiveAnswerState | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    const ids = (value: unknown) =>
      Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === "string")
        : [];
    const filters: Record<string, InteractiveAnswerValue[]> = {};
    if (isRecord(parsed.filters)) {
      for (const [key, values] of Object.entries(parsed.filters)) {
        if (Array.isArray(values)) {
          filters[key] = values.filter(
            (value): value is InteractiveAnswerValue => cellValue(value) !== undefined,
          );
        }
      }
    }
    const sort: InteractiveAnswerSort =
      isRecord(parsed.sort) &&
      typeof parsed.sort.key === "string" &&
      (parsed.sort.direction === "asc" || parsed.sort.direction === "desc")
        ? { key: parsed.sort.key, direction: parsed.sort.direction === "asc" ? "asc" : "desc" }
        : null;
    return {
      selected: ids(parsed.selected),
      sent: Array.isArray(parsed.sent) ? ids(parsed.sent) : null,
      view: parsed.view === "cards" || parsed.view === "table" ? parsed.view : null,
      sort,
      filters,
    };
  } catch {
    return null;
  }
}

/**
 * One answer's interaction state, kept apart from the answer itself (which
 * never changes once written) and remembered in the host's store. Ids that
 * no longer exist in the answer are dropped.
 */
export function useInteractiveAnswerState(
  answerKey: string,
  validIds: readonly string[] | null,
): [
  InteractiveAnswerState,
  (update: (state: InteractiveAnswerState) => InteractiveAnswerState) => void,
] {
  const { scope, store } = useInteractiveAnswerHost();
  const key = storageKey(scope, answerKey);
  const readSync = useCallback((): InteractiveAnswerState => {
    const fromMemory = readState(memoryStore.get(key));
    if (fromMemory) return fromMemory;
    if (!store) return EMPTY_INTERACTIVE_ANSWER_STATE;
    try {
      const value = store.get(key);
      return value instanceof Promise
        ? EMPTY_INTERACTIVE_ANSWER_STATE
        : (readState(value) ?? EMPTY_INTERACTIVE_ANSWER_STATE);
    } catch {
      return EMPTY_INTERACTIVE_ANSWER_STATE;
    }
  }, [key, store]);
  const [state, setState] = useState<InteractiveAnswerState>(readSync);
  const touched = useRef(false);
  const loadedKey = useRef(key);
  useEffect(() => {
    if (loadedKey.current !== key) {
      loadedKey.current = key;
      touched.current = false;
      setState(readSync());
    }
    if (!store || memoryStore.has(key)) return;
    let cancelled = false;
    Promise.resolve()
      .then(() => store.get(key))
      .then((value) => {
        const restored = readState(value);
        if (!cancelled && restored && !touched.current) setState(restored);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [key, readSync, store]);
  const update = useCallback(
    (change: (state: InteractiveAnswerState) => InteractiveAnswerState) => {
      touched.current = true;
      setState((current) => {
        const next = change(current);
        const serialized = JSON.stringify(next);
        memoryStore.set(key, serialized);
        try {
          void Promise.resolve(store?.set(key, serialized)).catch(() => undefined);
        } catch {
          // A full or unavailable store only loses memory across reloads.
        }
        return next;
      });
    },
    [key, store],
  );
  const clean = useMemo(() => {
    if (!validIds) return state;
    const valid = new Set(validIds);
    const selected = state.selected.filter((id) => valid.has(id));
    return selected.length === state.selected.length ? state : { ...state, selected };
  }, [state, validIds]);
  return [clean, update];
}

/** The browser's localStorage as an answer store, when it is usable. */
export function browserInteractiveAnswerStore(): InteractiveAnswerStore | undefined {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return undefined;
    return {
      get: (key) => storage.getItem(key),
      set: (key, value) => storage.setItem(key, value),
    };
  } catch {
    return undefined;
  }
}
