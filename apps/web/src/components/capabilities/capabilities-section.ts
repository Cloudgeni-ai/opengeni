/**
 * The Capabilities page's tabs, each a `?section=` of `/plugins` (none is
 * Connections). Kept free of React so the route table can parse it eagerly.
 */
export type CapabilitiesSection = "connections" | "skills" | "ready-made";

/** What Ready-made can be narrowed to (`?kind=`), for example from the Agents page. */
export type ReadyMadeKind = "agent" | "app" | "skill";

export const CAPABILITIES_SECTIONS: readonly CapabilitiesSection[] = [
  "connections",
  "skills",
  "ready-made",
];

/** Older tab names, kept so their links still land somewhere sensible. */
const LEGACY_SECTIONS: Readonly<Record<string, CapabilitiesSection>> = {
  plugins: "ready-made",
  gallery: "ready-made",
};

/** `?section=` of `/plugins`; anything else is Connections. */
export function capabilitiesSectionFromSearch(value: unknown): CapabilitiesSection | undefined {
  if (typeof value !== "string") return undefined;
  if (CAPABILITIES_SECTIONS.includes(value as CapabilitiesSection)) {
    return value as CapabilitiesSection;
  }
  return Object.hasOwn(LEGACY_SECTIONS, value) ? LEGACY_SECTIONS[value] : undefined;
}

export function readyMadeKindFromSearch(value: unknown): ReadyMadeKind | undefined {
  return value === "agent" || value === "app" || value === "skill" ? value : undefined;
}
