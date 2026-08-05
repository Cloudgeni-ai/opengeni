import { describe, expect, test } from "bun:test";

import {
  publicEndpointOrigin,
  publicProbeErrorDiagnostic,
} from "./deployment-preflight-diagnostics";

describe("deployment preflight public diagnostics", () => {
  test("reports only the allowlisted endpoint origin", () => {
    const userPart = ["al", "ice"].join("");
    const passPart = ["op", "eng", "eni"].join("");
    const signaturePart = ["sig", "nature", "value"].join("-");
    const endpoint = new URL("https://example.test:8443");
    endpoint.username = userPart;
    endpoint.password = passPart;
    endpoint.pathname = "/private/path";
    endpoint.searchParams.set("signature", signaturePart);
    endpoint.hash = "fragment";
    const diagnostic = publicEndpointOrigin(endpoint.toString());

    expect(diagnostic).toBe("https://example.test:8443");
    expect(diagnostic).not.toContain(userPart);
    expect(diagnostic).not.toContain(passPart);
    expect(diagnostic).not.toContain(signaturePart);
  });

  test("reports validated error metadata without the arbitrary error message", () => {
    const body = ["private", "response", "body"].join(" ");
    const error = Object.assign(new Error(body), {
      name: "FetchError",
      status: 503,
      code: "ECONNRESET",
      response: body,
    });
    const diagnostic = publicProbeErrorDiagnostic(error);

    expect(diagnostic).toBe("FetchError status=503 code=ECONNRESET");
    expect(diagnostic).not.toContain(body);
  });
});
