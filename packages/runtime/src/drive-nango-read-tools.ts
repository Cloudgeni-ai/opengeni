import type { MCPServer } from "@openai/agents";
import { Buffer } from "node:buffer";
import { z } from "zod";

/**
 * Google Drive read tools served from Drive REST when Drive is routed through
 * Nango (docs/nango.md). Google's hosted Drive MCP server only accepts its own
 * OAuth clients, so a Nango-managed connection cannot reach it; these tools
 * keep the hosted server's read tool names and their main arguments.
 */

const id = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9_-]+$/u);
const pageSize = z.number().int().min(1).max(100).default(25);
const pageToken = z.string().min(1).max(2048);

export const NANGO_DRIVE_READ_DEFINITIONS = {
  search_files: {
    description:
      "Search Google Drive files by text in their name or content. Returns file IDs, names, types and links; follow nextPageToken for more.",
    schema: z
      .object({
        query: z.string().min(1).max(1000),
        pageSize: pageSize.optional(),
        pageToken: pageToken.optional(),
      })
      .strict(),
  },
  list_recent_files: {
    description:
      "List the most recently modified Google Drive files. Follow nextPageToken for more.",
    schema: z
      .object({
        pageSize: pageSize.optional(),
        pageToken: pageToken.optional(),
        excludeContentSnippets: z.boolean().optional(),
      })
      .strict(),
  },
  get_file_metadata: {
    description:
      "Get a Google Drive file's metadata: name, type, owners, size, parents, times and links.",
    schema: z.object({ fileId: id }).strict(),
  },
  get_file_permissions: {
    description: "List who a Google Drive file is shared with and their roles.",
    schema: z.object({ fileId: id }).strict(),
  },
  read_file_content: {
    description:
      "Read a Google Drive file as text. Google Docs and Slides are exported as plain text and Sheets as CSV; other text files are read directly. Long content is truncated.",
    schema: z.object({ fileId: id }).strict(),
  },
  download_file_content: {
    description:
      "Download a Google Drive file (up to 10 MiB). It is saved to the agent's files when this chat has them; otherwise its bytes are returned as base64 (up to 1 MiB). Google Docs, Sheets and Slides are exported as PDF unless exportMimeType is given.",
    schema: z
      .object({
        fileId: id,
        exportMimeType: z
          .string()
          .min(1)
          .max(255)
          .regex(/^[\w.+-]+\/[\w.+-]+$/u)
          .optional(),
      })
      .strict(),
  },
} as const;

export type NangoDriveReadName = keyof typeof NANGO_DRIVE_READ_DEFINITIONS;

export const NANGO_DRIVE_READ_TOOLS = Object.entries(NANGO_DRIVE_READ_DEFINITIONS).map(
  ([name, definition]) => ({
    name,
    description: definition.description,
    inputSchema: z.toJSONSchema(definition.schema) as Awaited<
      ReturnType<MCPServer["listTools"]>
    >[number]["inputSchema"],
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }),
);

export function isNangoDriveReadTool(name: string): name is NangoDriveReadName {
  return Object.hasOwn(NANGO_DRIVE_READ_DEFINITIONS, name);
}

const API = "https://www.googleapis.com/drive/v3/";
const FILE_FIELDS =
  "id,name,mimeType,description,size,createdTime,modifiedTime,viewedByMeTime,parents,owners(displayName,emailAddress),webViewLink,iconLink,trashed,shared,driveId";
const LIST_FIELDS = `nextPageToken,files(${FILE_FIELDS})`;
export const NANGO_DRIVE_MAX_TEXT_CHARS = 200_000;
export const NANGO_DRIVE_MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;
/** Inline base64 is only for chats without agent files; keep tool results small. */
export const NANGO_DRIVE_MAX_INLINE_BYTES = 1024 * 1024;

const TEXT_EXPORTS: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.presentation": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.drawing": "image/svg+xml",
};

function escapeQuery(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

/** One planned Drive REST read: the exact URL plus how to read the response. */
export type NangoDriveReadPlan = {
  url: URL;
  read: "json" | "text" | "bytes";
  /** For content reads: the file metadata request that decides export vs media. */
  needsMetadata?: boolean;
};

export function parseNangoDriveRead(
  name: NangoDriveReadName,
  args: Record<string, unknown> | null,
): { ok: true; input: Record<string, unknown> } | { ok: false; error: string } {
  const parsed = NANGO_DRIVE_READ_DEFINITIONS[name].schema.safeParse(args ?? {});
  return parsed.success
    ? { ok: true, input: parsed.data as Record<string, unknown> }
    : { ok: false, error: parsed.error.message };
}

export function nangoDriveListUrl(
  name: "search_files" | "list_recent_files",
  input: Record<string, unknown>,
): URL {
  const url = new URL(`${API}files`);
  url.searchParams.set("pageSize", String(input.pageSize ?? 25));
  if (typeof input.pageToken === "string") url.searchParams.set("pageToken", input.pageToken);
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  url.searchParams.set("fields", LIST_FIELDS);
  if (name === "search_files") {
    const text = escapeQuery(String(input.query));
    url.searchParams.set(
      "q",
      `(name contains '${text}' or fullText contains '${text}') and trashed = false`,
    );
  } else {
    url.searchParams.set("q", "trashed = false");
    url.searchParams.set("orderBy", "modifiedTime desc");
  }
  return url;
}

export function nangoDriveMetadataUrl(fileId: string): URL {
  const url = new URL(`${API}files/${fileId}`);
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("fields", FILE_FIELDS);
  return url;
}

export function nangoDrivePermissionsUrl(fileId: string): URL {
  const url = new URL(`${API}files/${fileId}/permissions`);
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set(
    "fields",
    "permissions(id,type,role,emailAddress,domain,displayName,allowFileDiscovery,deleted)",
  );
  return url;
}

/** Export for Google-native files, media download for everything else. */
export function nangoDriveContentUrl(
  fileId: string,
  mimeType: string,
  purpose: "text" | "bytes",
  exportMimeType?: string,
): URL | { error: string } {
  if (mimeType.startsWith("application/vnd.google-apps.")) {
    const target =
      purpose === "text" ? TEXT_EXPORTS[mimeType] : (exportMimeType ?? "application/pdf");
    if (!target) return { error: `This Google file type (${mimeType}) cannot be exported.` };
    const url = new URL(`${API}files/${fileId}/export`);
    url.searchParams.set("mimeType", target);
    return url;
  }
  if (
    purpose === "text" &&
    !/^(?:text\/|application\/(?:json|xml|x-yaml|yaml|csv|javascript|x-sh))/u.test(mimeType)
  )
    return { error: `This file (${mimeType}) is not text. Use download_file_content.` };
  const url = new URL(`${API}files/${fileId}`);
  url.searchParams.set("alt", "media");
  url.searchParams.set("supportsAllDrives", "true");
  return url;
}

export function projectNangoDriveText(bytes: Uint8Array): { text: string; truncated: boolean } {
  const text = Buffer.from(bytes).toString("utf8");
  return text.length > NANGO_DRIVE_MAX_TEXT_CHARS
    ? { text: text.slice(0, NANGO_DRIVE_MAX_TEXT_CHARS), truncated: true }
    : { text, truncated: false };
}
