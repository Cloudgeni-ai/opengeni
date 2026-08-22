import type {
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
import type { OpenGeniClient as OpenGeniCoreClient } from "./client";

export type OpenGeniAutomationsTransport = Pick<OpenGeniCoreClient, "requestJson">;

export class OpenGeniAutomationsClient {
  constructor(private readonly client: OpenGeniAutomationsTransport) {}

  async listSources(workspaceId: string): Promise<AutomationSource[]> {
    const result = await this.client.requestJson<{ sources: AutomationSource[] }>(
      "GET",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/automations/sources`,
    );
    return result.sources;
  }

  async createSource(
    workspaceId: string,
    request: CreateAutomationSourceRequest,
  ): Promise<AutomationSource> {
    return await this.client.requestJson(
      "POST",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/automations/sources`,
      request,
    );
  }

  async updateSource(
    workspaceId: string,
    sourceId: string,
    request: UpdateAutomationSourceRequest,
  ): Promise<AutomationSource> {
    return await this.client.requestJson(
      "PATCH",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/automations/sources/${encodeURIComponent(sourceId)}`,
      request,
    );
  }

  async disableSource(workspaceId: string, sourceId: string): Promise<void> {
    await this.client.requestJson(
      "DELETE",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/automations/sources/${encodeURIComponent(sourceId)}`,
    );
  }

  async listTriggers(workspaceId: string): Promise<AutomationTrigger[]> {
    const result = await this.client.requestJson<{ triggers: AutomationTrigger[] }>(
      "GET",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/automations/triggers`,
    );
    return result.triggers;
  }

  async createTrigger(
    workspaceId: string,
    request: CreateAutomationTriggerRequest,
  ): Promise<AutomationTrigger> {
    return await this.client.requestJson(
      "POST",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/automations/triggers`,
      request,
    );
  }

  async updateTrigger(
    workspaceId: string,
    triggerId: string,
    request: UpdateAutomationTriggerRequest,
  ): Promise<AutomationTrigger> {
    return await this.client.requestJson(
      "PATCH",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/automations/triggers/${encodeURIComponent(triggerId)}`,
      request,
    );
  }

  async disableTrigger(
    workspaceId: string,
    triggerId: string,
    expectedRevision: number,
  ): Promise<void> {
    await this.client.requestJson(
      "DELETE",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/automations/triggers/${encodeURIComponent(triggerId)}?expectedRevision=${expectedRevision}`,
    );
  }

  async listRuns(workspaceId: string): Promise<AutomationRun[]> {
    const result = await this.client.requestJson<{ runs: AutomationRun[] }>(
      "GET",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/automations/runs`,
    );
    return result.runs;
  }

  async triggerManually(
    workspaceId: string,
    sourceId: string,
    request: TriggerAutomationManuallyRequest,
  ): Promise<AutomationWebhookResult> {
    return await this.client.requestJson(
      "POST",
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/automations/sources/${encodeURIComponent(sourceId)}/events`,
      request,
    );
  }
}
