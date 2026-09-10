import { HTTPException } from "hono/http-exception";
import type { Settings } from "@opengeni/config";
import type { ToolRef, ScheduledTask, AccessGrant } from "@opengeni/contracts";
import {
  HostMcpBindingDefinition,
  HostMcpCreateSelections,
} from "@opengeni/contracts/host-mcp-bindings";
import {
  captureHostMcpTaskAuthorities,
  HostMcpDelegationAuthorityError,
  inheritHostMcpTaskAuthoritiesFromAttempt,
  type Database,
} from "@opengeni/db";
import { hasPermission, type AccessGrantAuthorization } from "../access";
import { prepareHostMcpOwnerAuthorization } from "../application/host-mcp-owner";
import { assertHostMcpAuthoritySourceAdmissionEnabled } from "./host-mcp-authority-source-admission";

/** Internal closure, not a caller-provided callback or durable key dependency. */
export function prepareHostMcpTaskAdmission(input: {
  settings: Settings;
  tools: ToolRef[];
  grant: AccessGrant;
  authorization?: AccessGrantAuthorization;
  selections: unknown;
}): (tx: Database, task: ScheduledTask) => Promise<void> {
  const selections = HostMcpCreateSelections.parse(input.selections);
  if (
    !input.authorization ||
    input.authorization.grant.accountId !== input.grant.accountId ||
    input.authorization.grant.subjectId !== input.grant.subjectId ||
    input.authorization?.grant.workspaceId !== input.grant.workspaceId ||
    input.grant.metadata?.["sessionId"] ||
    !hasPermission(input.authorization?.grant.permissions ?? [], "connections:read") ||
    !hasPermission(input.grant.permissions, "connections:read")
  )
    throw new HTTPException(403, {
      message: "Host task selection requires a verified owner",
    });
  const reauthorize = prepareHostMcpOwnerAuthorization(
    input.authorization,
    input.grant.workspaceId,
    "connections:read",
  );
  const prepared = selections.map((selection) => {
    const server = input.settings.mcpServers.find(
      (candidate) => candidate.id === selection.serverId,
    );
    if (
      !server?.url ||
      server.connectionRef?.authoritySource !== "host" ||
      !server.connectionRef.hostBinding ||
      !input.tools.some((tool) => tool.kind === "mcp" && tool.id === selection.serverId)
    )
      throw new HTTPException(422, {
        message: "Host task selection must match a selected configured server",
      });
    assertHostMcpAuthoritySourceAdmissionEnabled(input.settings, server.connectionRef);
    const { hostBinding, ...connectionRef } = server.connectionRef;
    return {
      delegationId: selection.delegationId,
      generation: selection.generation,
      bindingId: hostBinding.bindingId,
      bindingGeneration: hostBinding.generation,
      definition: HostMcpBindingDefinition.parse({
        serverId: selection.serverId,
        destinationUrl: server.url,
        connectionRef,
      }),
    };
  });
  return async (tx, task) => {
    const owner = await reauthorize(tx);
    try {
      if (prepared.length) await captureHostMcpTaskAuthorities(tx, owner, task, prepared);
    } catch (error) {
      if (error instanceof HostMcpDelegationAuthorityError)
        throw new HTTPException(403, { message: error.message });
      throw error;
    }
  };
}

export function prepareInheritedHostMcpTaskAdmission(
  settings: Settings,
  tools: ToolRef[],
  source: { sessionId: string; turnId: string; attemptId: string; executionGeneration: number },
): (tx: Database, task: ScheduledTask) => Promise<void> {
  const configured = settings.mcpServers.flatMap((server) => {
    if (
      !tools.some((tool) => tool.kind === "mcp" && tool.id === server.id) ||
      server.connectionRef?.authoritySource !== "host" ||
      !server.connectionRef.hostBinding ||
      !server.url
    )
      return [];
    assertHostMcpAuthoritySourceAdmissionEnabled(settings, server.connectionRef);
    const { hostBinding, ...connectionRef } = server.connectionRef;
    return [
      {
        bindingId: hostBinding.bindingId,
        bindingGeneration: hostBinding.generation,
        definition: HostMcpBindingDefinition.parse({
          serverId: server.id,
          destinationUrl: server.url,
          connectionRef,
        }),
      },
    ];
  });
  return (tx, task) => inheritHostMcpTaskAuthoritiesFromAttempt(tx, task, source, configured);
}
