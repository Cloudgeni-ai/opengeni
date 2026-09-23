import type { ToolGatewayIdentity } from "@opengeni/contracts";
import { isDeepStrictEqual } from "node:util";

/** Small request identity only: never HTML, source payloads, or content hashes. */
export function sitePublicationRequest(input: {
  uploadId?: string;
  title?: string;
  description?: string | null;
  requestedSlug?: string | null;
  requestedTools?: ToolGatewayIdentity[];
}) {
  return {
    uploadId: input.uploadId ?? null,
    title: input.title ?? null,
    description: input.description === undefined ? { omitted: true } : input.description,
    requestedSlug: input.requestedSlug ?? null,
    requestedTools:
      input.requestedTools === undefined
        ? null
        : input.requestedTools
            .map(({ serverId, toolName }) => [serverId, toolName])
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
}

export function sameSitePublicationRequest(
  recorded: unknown,
  input: Parameters<typeof sitePublicationRequest>[0],
) {
  // Old events predate the small receipt. Keep their original replay semantics.
  return recorded == null || isDeepStrictEqual(recorded, sitePublicationRequest(input));
}
