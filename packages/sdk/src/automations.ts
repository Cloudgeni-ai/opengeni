/**
 * The first automation API, deprecated: automations are scheduled tasks with
 * event triggers now (`createEventSource`, then `createScheduledTask` with
 * `events`). Removed in the next major.
 */
export { OpenGeniAutomationsClient } from "./automations-client";
export type { OpenGeniAutomationsTransport } from "./automations-client";
export type {
  AutomationAcceptedExecution,
  AutomationNormalizedEvent,
  AutomationRun,
  AutomationSource,
  AutomationTrigger,
  AutomationWebhookResult,
  CreateAutomationSourceRequest,
  CreateAutomationTriggerRequest,
  TriggerAutomationManuallyRequest,
  UpdateAutomationSourceRequest,
  UpdateAutomationTriggerRequest,
} from "@opengeni/contracts";
