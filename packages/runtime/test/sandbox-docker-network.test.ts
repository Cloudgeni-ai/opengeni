import { describe, expect, test } from "bun:test";
import { dockerNetworkExposedPortEndpoint } from "../src/sandbox";

describe("Docker sandbox network endpoint", () => {
  test("uses container DNS and the original port after provider validation", () => {
    const containerId = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
    expect(
      dockerNetworkExposedPortEndpoint(containerId, 7682, {
        host: "127.0.0.1",
        port: 32817,
        tls: false,
        path: "/",
        query: "signed=provider-value",
      }),
    ).toEqual({
      host: "1234567890ab",
      port: 7682,
      tls: false,
      path: "/",
      query: "signed=provider-value",
    });
  });

  test("preserves a non-hex Docker network alias", () => {
    expect(
      dockerNetworkExposedPortEndpoint("browser-sandbox", 7682, {
        host: "127.0.0.1",
        port: 49152,
      }),
    ).toEqual({ host: "browser-sandbox", port: 7682 });
  });
});
