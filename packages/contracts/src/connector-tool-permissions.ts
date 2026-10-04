import { z } from "zod";
import { MCP_MAX_CATALOG_TOOL_ENTRIES } from "./mcp-catalog-limits";

export const ConnectorToolPermission = z.enum(["allow", "ask", "block"]);
export type ConnectorToolPermission = z.infer<typeof ConnectorToolPermission>;

export const ConnectorToolPermissionEntry = z.object({
  name: z.string().min(1).max(512),
  title: z.string().optional(),
  description: z.string().optional(),
  group: z.enum(["read", "write", "other"]),
  permission: ConnectorToolPermission,
  inherited: z.boolean(),
  resetReason: z.literal("operation_changed").optional(),
  approvalRequired: z.boolean(),
  source: z.enum(["recommended", "connector_default", "tool", "action", "conflict"]).optional(),
  conditional: z.boolean().optional(),
  actionPermissions: z
    .array(
      z.object({
        actionName: z.string(),
        permission: ConnectorToolPermission,
      }),
    )
    .optional(),
});
export type ConnectorToolPermissionEntry = z.infer<typeof ConnectorToolPermissionEntry>;

export const ConnectorToolPermissionsResponse = z.object({
  connectionId: z.string(),
  serverId: z.string(),
  defaultPermission: ConnectorToolPermission.nullable(),
  tools: z.array(ConnectorToolPermissionEntry),
  discoveryError: z.string().nullable(),
  canManage: z.boolean(),
  appliesTo: z.literal("next_attempt").optional(),
  revision: z.string().optional(),
  accountLabel: z.string().optional(),
  instanceKey: z.string().optional(),
  accounts: z
    .array(
      z.object({
        connectionId: z.string(),
        label: z.string(),
        scope: z.enum(["personal", "workspace", "none"]),
        instanceKey: z.string().optional(),
      }),
    )
    .optional(),
});
export type ConnectorToolPermissionsResponse = z.infer<typeof ConnectorToolPermissionsResponse>;

// Group changes name the currently displayed tools explicitly. MCP annotations
// organize the UI only; they never grant future tools permission automatically.
export const UpdateConnectorToolPermissionsRequest = z.discriminatedUnion("target", [
  z
    .object({
      connectionId: z.string().min(1).max(512),
      target: z.literal("default"),
      permission: ConnectorToolPermission.nullable(),
      expectedRevision: z.string().optional(),
      instanceKey: z.string().optional(),
    })
    .strict(),
  z
    .object({
      connectionId: z.string().min(1).max(512),
      target: z.literal("tools"),
      toolNames: z
        .array(
          z
            .string()
            .min(1)
            .max(512)
            .refine((name) => name !== "*" && name === name.trim(), {
              message: "Tool names must be exact and cannot use the connector-default wildcard.",
            }),
        )
        .min(1)
        .max(MCP_MAX_CATALOG_TOOL_ENTRIES),
      permission: ConnectorToolPermission.nullable(),
      expectedRevision: z.string().optional(),
      instanceKey: z.string().optional(),
    })
    .strict(),
  z
    .object({
      connectionId: z.string().min(1).max(512),
      target: z.literal("action"),
      toolName: z
        .string()
        .min(1)
        .max(512)
        .refine((value) => value !== "*" && value === value.trim()),
      actionName: z
        .string()
        .min(1)
        .max(512)
        .refine((value) => value !== "*" && value === value.trim()),
      permission: ConnectorToolPermission.nullable(),
      expectedRevision: z.string().optional(),
      instanceKey: z.string().optional(),
    })
    .strict(),
]);
export type UpdateConnectorToolPermissionsRequest = z.infer<
  typeof UpdateConnectorToolPermissionsRequest
>;
