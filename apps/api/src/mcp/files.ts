import type { AccessGrant } from "@opengeni/contracts";
import { requireFile } from "@opengeni/db";
import { hasPermission, type ApiRouteDeps } from "@opengeni/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

/** Dedicated file MCP surface. The broad `opengeni` server never registers it. */
export function buildFilesMcpServer(deps: ApiRouteDeps, grant: AccessGrant): McpServer {
  const server = new McpServer({
    name: "opengeni-files",
    version: "1.0.0",
  });

  if (!hasPermission(grant.permissions, "files:read")) {
    server
      .registerTool(
        "__opengeni_empty_files_surface__",
        {
          description: "Internal disabled placeholder for an unauthorized files surface.",
          inputSchema: z.object({}),
        },
        async () => ({
          content: [{ type: "text" as const, text: '{"unavailable":true}' }],
        }),
      )
      .disable();
    return server;
  }

  server.registerTool(
    "files_get_download_url",
    {
      description: "Create a short-lived download URL for a ready file asset.",
      inputSchema: { fileId: z.string().uuid() },
    },
    async ({ fileId }) => {
      if (!deps.objectStorage) {
        throw new Error("object storage is not configured");
      }
      const file = await requireFile(deps.db, grant.workspaceId, fileId);
      if (file.status !== "ready") {
        throw new Error(`file is ${file.status}`);
      }
      const signed = await deps.objectStorage.createGetUrl({ key: file.objectKey });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                file: {
                  id: file.id,
                  filename: file.filename,
                  safeFilename: file.safeFilename,
                  contentType: file.contentType,
                  sizeBytes: file.sizeBytes,
                  sha256: file.sha256,
                  status: file.status,
                  createdAt: file.createdAt,
                  updatedAt: file.updatedAt,
                },
                downloadUrl: {
                  url: signed.url,
                  expiresAt: signed.expiresAt.toISOString(),
                },
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  return server;
}
