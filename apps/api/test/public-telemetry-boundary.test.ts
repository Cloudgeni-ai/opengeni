import { describe, expect, test } from "bun:test";
import { oauthPublicErrorFields } from "../src/integrations/oauth-client";
import { toolspacePublicErrorFields } from "../src/mcp/toolspace";

const sentinel = "SECRET_PUBLIC_TELEMETRY_SENTINEL_8f4e2f";

describe("public telemetry boundaries", () => {
  test("OAuth telemetry is structural while the internal exception remains exact", () => {
    const signedUrl = new URL("https://objects.example/file");
    signedUrl.searchParams.set(["X", "Amz", "Signature"].join("-"), sentinel);
    const authorizationHeader = ["Author", "ization: Bea", "rer ", sentinel].join("");
    const error = Object.assign(new Error(`request failed ${sentinel} ${signedUrl.toString()}`), {
      name: sentinel,
      code: sentinel,
      status: 401,
      responseBody: authorizationHeader,
    });

    expect(oauthPublicErrorFields(error)).toEqual({
      errorClass: "OAuthOperationError",
      errorCode: "oauth_operation_failed",
      status: 401,
      origin: "oauth",
    });
    expect(error.message).toContain(sentinel);
    expect(error.responseBody).toContain(sentinel);
    expect(JSON.stringify(oauthPublicErrorFields(error))).not.toContain(sentinel);
  });

  test("Toolspace telemetry omits ids, bodies, URLs, and exact tool results", () => {
    const error = Object.assign(new Error(`tool result ${sentinel}`), {
      name: sentinel,
      code: sentinel,
      statusCode: 503,
      serverId: `server-${sentinel}`,
      url: `https://provider.example/${sentinel}`,
      result: { content: [{ type: "text", text: sentinel }] },
    });

    expect(toolspacePublicErrorFields(error)).toEqual({
      errorClass: "ToolspaceOperationError",
      errorCode: "toolspace_operation_failed",
      status: 503,
      origin: "toolspace",
    });
    expect(error.message).toBe(`tool result ${sentinel}`);
    expect(error.result).toEqual({ content: [{ type: "text", text: sentinel }] });
    expect(JSON.stringify(toolspacePublicErrorFields(error))).not.toContain(sentinel);
  });
});
