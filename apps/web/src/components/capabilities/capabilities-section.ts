/**
 * The Capabilities page's tabs. Knowledge keeps its own address (`/state`);
 * the rest are `?section=` of `/plugins`. Kept free of React so the route
 * table can parse it eagerly.
 */
export type CapabilitiesSection = "connections" | "skills" | "plugins" | "gallery";
export type SetupTab = CapabilitiesSection | "knowledge";

export const CAPABILITIES_SECTIONS: readonly CapabilitiesSection[] = [
  "connections",
  "skills",
  "plugins",
  "gallery",
];

/** `?section=` of `/plugins`; anything else is Connections. */
export function capabilitiesSectionFromSearch(value: unknown): CapabilitiesSection | undefined {
  return CAPABILITIES_SECTIONS.includes(value as CapabilitiesSection)
    ? (value as CapabilitiesSection)
    : undefined;
}
