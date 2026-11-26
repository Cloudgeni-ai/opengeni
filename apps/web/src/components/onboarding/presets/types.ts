/**
 * What one onboarding answer suggests. Suggestions are only links: each
 * opens Enable (or Get started for a setup), so nothing is added until the
 * person turns it on. Only ready-mades that exist belong here.
 */
export type PersonaPreset = {
  /** The sidebar group the suggestions go in. */
  group: string;
  icon: "code" | "briefcase";
  /** Ready-made agents by template key, in order. */
  agents: readonly { key: string; label: string; icon: "git-pull-request" | "bug" | "package" }[];
  /** One setup on Get started, if any. */
  setup: { key: string; label: string } | null;
  /** Ready-made apps by template key. */
  apps: readonly { key: string; label: string; icon: "megaphone" | "list-checks" }[];
  /** Connections to suggest, by name, in one Connect link. */
  connections: readonly string[];
};
