// @opengeni/react/automation-model: automations as people read them, with no
// React or DOM, for hosts that draw their own screens (React Native, a CLI,
// a server-rendered digest). When one runs in words, its next run, the order
// a list shows them in, what a run did, and the first message of a chat that
// creates one. The same functions back `@opengeni/react/automations` and the
// web app's Automations pages; words come from the host's catalog, so each
// function that returns text takes the `t` of `useOpenGeniText()` first.
export {
  AUTOMATION_NAME_MAX_LENGTH,
  automationAgentOpeningMessage,
  automationCadence,
  automationListensForEvents,
  automationNextRun,
  automationRunErrorText,
  automationRunEventsLabel,
  automationRunStatusLabel,
  automationRunTriggerLabel,
  automationScheduleWords,
  automationWhenSentence,
  automationWhenWords,
  deriveAutomationName,
  hasEventTriggers,
  isAgentAutomation,
  isFinishedOnce,
  sessionAutomationWaitWords,
  sortAutomations,
  viewerTimeZone,
  type AutomationScheduleWords,
  type SessionAutomationWaitWords,
} from "./components/automations/automation-model";
export { formatRunTime, type RunFormatOptions } from "./ui/cadence-model";
// The times the pages show: "2 hours ago" for a run, as `RelativeTime` says it.
export { formatRelativeTime, type TimeFormatOptions } from "./ui/time-format";
