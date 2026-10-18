import { createContext, useContext, useMemo, type ReactNode } from "react";
import { englishMessages } from "./en";
import { singleSendText } from "./single-send";

/**
 * Every user-visible string the components render comes from one catalog, so a host can
 * show its own words and languages instead of the built-in English.
 *
 * - Keys are stable, dot-separated identifiers (`composer.send`). `englishMessages` is the
 *   complete default catalog; export it to your translation tooling as is.
 * - Templates use single-brace interpolation: `"Move queued prompt {index} up"`.
 * - Counted text uses plural-category suffixes (`_zero`, `_one`, `_two`, `_few`, `_many`,
 *   `_other`) selected with `Intl.PluralRules` for the active locale, so a language can supply
 *   exactly the forms it needs. `_other` is required for every counted key. Where the
 *   runtime has no `Intl.PluralRules` (Hermes on React Native), 1 selects `_one` and every
 *   other count `_other`.
 * - A key a host does not supply falls back to an outer provider, then English, never to a
 *   raw key.
 */
type Catalog = typeof englishMessages;
type CatalogKey = keyof Catalog & string;

export type PluralCategory = "zero" | "one" | "two" | "few" | "many" | "other";
type PluralSuffix = `_${PluralCategory}`;

type PluralBase<K> = K extends `${infer Base}_other` ? Base : never;
type PluralBaseKey = PluralBase<CatalogKey>;
type SingularKey<K> = K extends `${string}${PluralSuffix}` ? never : K;

/** A key a component asks for: plain keys, and counted keys without their plural suffix. */
export type OpenGeniMessageKey = SingularKey<CatalogKey> | PluralBaseKey;

type TemplateParams<S> = S extends `${string}{${infer Param}}${infer Rest}`
  ? Param | TemplateParams<Rest>
  : never;
type TemplateOf<K> = K extends CatalogKey
  ? Catalog[K]
  : K extends PluralBaseKey
    ? Catalog[`${K}_other` & CatalogKey]
    : never;
type ParamNames<K> = TemplateParams<TemplateOf<K>> | (K extends PluralBaseKey ? "count" : never);

/** Values interpolated into templates; `null` and `undefined` render as empty text. */
export type MessageParamValue = string | number | null | undefined;
export type OpenGeniMessageParams<K extends OpenGeniMessageKey> = {
  [P in ParamNames<K>]: P extends "count" ? number : MessageParamValue;
};

/**
 * Translate one key. Parameters are required exactly when the English template has them.
 * `locale` is the host locale to format dates, times and numbers with (`undefined` is the
 * runtime default).
 */
export type OpenGeniText = (<K extends OpenGeniMessageKey>(
  key: K,
  ...params: [ParamNames<K>] extends [never] ? [] : [OpenGeniMessageParams<K>]
) => string) & { readonly locale: string | undefined };

/**
 * Host-supplied text. Any subset of keys; counted keys may add the plural forms their
 * language uses (`files.count_few`) even where English has none.
 */
export type OpenGeniMessages = Partial<
  Record<SingularKey<CatalogKey> | `${PluralBaseKey}${PluralSuffix}`, string>
>;

/** A complete catalog: declare yours with this type to be told about every new key. */
export type OpenGeniMessageCatalog = Record<SingularKey<CatalogKey>, string> &
  Record<`${PluralBaseKey}_other`, string> &
  Partial<Record<`${PluralBaseKey}${PluralSuffix}`, string>>;

type Lookup = Readonly<Record<string, string | undefined>>;
type UntypedText = (key: string, params?: Record<string, MessageParamValue>) => string;

type PluralSelector = { select(count: number): string };
/** One/other, for runtimes without `Intl.PluralRules`. */
const ONE_OTHER: PluralSelector = { select: (count) => (count === 1 ? "one" : "other") };
const pluralRuleCache = new Map<string, PluralSelector>();
function pluralRules(locale: string | undefined): PluralSelector {
  const cacheKey = locale ?? "";
  let rules = pluralRuleCache.get(cacheKey);
  if (!rules) {
    rules = createPluralRules(locale) ?? createPluralRules("en") ?? ONE_OTHER;
    pluralRuleCache.set(cacheKey, rules);
  }
  return rules;
}

function createPluralRules(locale: string | undefined): PluralSelector | null {
  if (typeof Intl === "undefined" || typeof Intl.PluralRules !== "function") return null;
  try {
    return new Intl.PluralRules(locale);
  } catch {
    return null;
  }
}

function interpolate(template: string, params: Record<string, MessageParamValue> | undefined) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name] ?? "") : match,
  );
}

function pick(
  catalog: Lookup,
  key: string,
  locale: string | undefined,
  count: number | undefined,
): string | undefined {
  if (count === undefined) return catalog[key];
  const category = pluralRules(locale).select(count);
  return catalog[`${key}_${category}`] ?? catalog[`${key}_other`] ?? catalog[key];
}

function countOf(params: Record<string, MessageParamValue> | undefined): number | undefined {
  return typeof params?.count === "number" ? params.count : undefined;
}

function layeredText(
  host: Lookup,
  locale: string | undefined,
  fallback: UntypedText | null,
): OpenGeniText {
  const defaults: Lookup = englishMessages;
  const text: UntypedText = (key, params) => {
    const count = countOf(params);
    const own = pick(host, key, locale, count);
    if (own !== undefined) return interpolate(own, params);
    if (fallback) return fallback(key, params);
    return interpolate(pick(defaults, key, "en", count) ?? key, params);
  };
  return Object.assign(text, { locale }) as unknown as OpenGeniText;
}

/** The plain translation function, for code outside React and for tests. */
export function createOpenGeniText(
  options: { messages?: OpenGeniMessages | undefined; locale?: string | undefined } = {},
): OpenGeniText {
  return layeredText(options.messages ?? {}, options.locale, null);
}

type MessagesContextValue = {
  text: OpenGeniText;
  locale: string | undefined;
};

const ENGLISH: MessagesContextValue = { text: createOpenGeniText(), locale: undefined };
const MessagesContext = createContext<MessagesContextValue>(ENGLISH);

export type OpenGeniMessagesProviderProps = {
  /** BCP 47 locale for plural rules and for the dates, times and numbers components format. */
  locale?: string | undefined;
  /** Your text for any subset of keys. Missing keys come from an outer provider, then English. */
  messages?: OpenGeniMessages | undefined;
  children?: ReactNode;
};

/**
 * Supplies text and locale to every Opengeni component below it. `OpenGeniProvider`
 * accepts the same `locale` and `messages`; use this one for components rendered outside it.
 */
export function OpenGeniMessagesProvider({
  locale,
  messages,
  children,
}: OpenGeniMessagesProviderProps) {
  const outer = useContext(MessagesContext);
  const value = useMemo<MessagesContextValue>(() => {
    if (!messages && locale === undefined) return outer;
    const resolvedLocale = locale ?? outer.locale;
    const fallback = outer === ENGLISH ? null : (outer.text as unknown as UntypedText);
    return { text: layeredText(messages ?? {}, resolvedLocale, fallback), locale: resolvedLocale };
  }, [locale, messages, outer]);
  return <MessagesContext.Provider value={value}>{children}</MessagesContext.Provider>;
}

/** The translation function of the nearest messages provider (English without one). */
export function useOpenGeniText(): OpenGeniText {
  return useContext(MessagesContext).text;
}

/**
 * Words for one Send: while `enabled`, every Opengeni component below reads
 * the single-Send wording (`singleSendText`) instead of Queue and Steer
 * phrases. The stock conversation screens apply it themselves under
 * `busySend: "steer"`; use it around your own composition of the parts.
 */
export function SingleSendWording({
  enabled = true,
  children,
}: {
  enabled?: boolean | undefined;
  children?: ReactNode;
}) {
  const outer = useContext(MessagesContext);
  const value = useMemo<MessagesContextValue>(
    () => (enabled ? { text: singleSendText(outer.text), locale: outer.locale } : outer),
    [enabled, outer],
  );
  return <MessagesContext.Provider value={value}>{children}</MessagesContext.Provider>;
}

/** The host locale for formatting, or `undefined` for the runtime default. */
export function useOpenGeniLocale(): string | undefined {
  return useContext(MessagesContext).locale;
}
