import type { PersonaPreset } from "./types";

/**
 * "Software engineer". Not yet a ready-made, so left out: the Deployments app.
 */
export const SOFTWARE_ENGINEER_PRESET: PersonaPreset = {
  group: "Engineering",
  icon: "code",
  agents: [
    { key: "bug-fixer", label: "Bug fixer", icon: "bug" },
    { key: "dependency-updater", label: "Dependency updater", icon: "package" },
  ],
  // The PR reviewer, through its guided setup.
  setup: { key: "pr-reviews", label: "PR reviewer" },
  apps: [{ key: "work-summary", label: "Work summary", icon: "file-text" }],
  connections: ["GitHub", "Slack", "Linear"],
  rail: {
    top: ["new_session", "agents", "inbox", "apps", "setup"],
    setup: ["automations", "knowledge", "artifacts", "meetings"],
  },
};
