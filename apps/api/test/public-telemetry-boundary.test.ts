import { describe, expect, test } from "bun:test";
import { oauthPublicErrorFields } from "../src/integrations/oauth-client";

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

  test("public OAuth status projection tolerates hostile proxies without exposing content", () => {
    const source = new Error(`hostile API error ${sentinel}`);
    const hostile = new Proxy(source, {
      get(target, property, receiver) {
        if (property === "status" || property === "statusCode") {
          throw new Error(`hostile API status getter ${sentinel}`);
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(oauthPublicErrorFields(hostile)).toEqual({
      errorClass: "OAuthOperationError",
      errorCode: "oauth_operation_failed",
      origin: "oauth",
    });
    expect(source.message).toContain(sentinel);
    expect(JSON.stringify(oauthPublicErrorFields(hostile))).not.toContain(sentinel);
  });
});
