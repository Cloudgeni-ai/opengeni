import type { PersonaPreset } from "./types";

/**
 * "Not an engineer". Not yet ready-mades, so left out: the Meeting notes and
 * Weekly brief agents and the Work summary app. Rail order (Inbox, Agents,
 * Apps, Meetings, Knowledge first) needs the personal nav order from #8183.
 */
export const NOT_AN_ENGINEER_PRESET: PersonaPreset = {
  group: "Your work",
  icon: "briefcase",
  agents: [],
  setup: null,
  apps: [{ key: "feedback-board", label: "Feedback board", icon: "megaphone" }],
  connections: ["Slack", "Google Drive", "Gmail", "Google Calendar"],
};
