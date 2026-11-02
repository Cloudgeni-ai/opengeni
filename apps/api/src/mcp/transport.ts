import {
  WebStandardStreamableHTTPServerTransport,
  type WebStandardStreamableHTTPServerTransportOptions,
} from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

/**
 * The API's global request-body limit already bounds every MCP route before the
 * transport reads it (`apiRequestBodyLimitBytes`). The SDK's own default is a
 * lower 4 MiB, which would refuse tool calls the API admits, so the transport
 * defers to the API's single limit instead of adding a second, smaller one.
 */
export const API_MCP_TRANSPORT_MAX_REQUEST_BODY_BYTES = Number.MAX_SAFE_INTEGER;

export function createApiMcpTransport(
  options: WebStandardStreamableHTTPServerTransportOptions = {},
): WebStandardStreamableHTTPServerTransport {
  return new WebStandardStreamableHTTPServerTransport({
    ...options,
    maxRequestBodySize: API_MCP_TRANSPORT_MAX_REQUEST_BODY_BYTES,
  });
}
