import type { PersonaPreset } from "./types";

/**
 * "Not an engineer". Not yet ready-mades, so left out: the Meeting notes and
 * Weekly brief agents.
 */
export const NOT_AN_ENGINEER_PRESET: PersonaPreset = {
  group: "Your work",
  icon: "briefcase",
  agents: [],
  setup: null,
  apps: [
    { key: "work-summary", label: "Work summary", icon: "file-text" },
    { key: "feedback-board", label: "Feedback board", icon: "megaphone" },
  ],
  connections: ["Slack", "Google Drive", "Gmail", "Google Calendar"],
  rail: {
    top: ["new_session", "inbox", "agents", "apps", "meetings", "knowledge", "setup"],
    setup: ["automations", "artifacts"],
  },
};
