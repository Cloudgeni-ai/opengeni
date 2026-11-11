import { describe, expect, test } from "bun:test";
import { OpenGeniApiError } from "@opengeni/sdk";

import { ApiError } from "./app-api";
import {
  BOOTSTRAP_CALM_WINDOW_MS,
  bootstrapErrorPresentation,
  bootstrapWaitingPresentation,
  isTransientBootstrapError,
} from "./bootstrap-error";

describe("bootstrap error presentation", () => {
  test("turns the maintenance API payload into calm maintenance copy", () => {
    const presentation = bootstrapErrorPresentation(
      new ApiError(503, JSON.stringify({ error: "maintenance" })),
      "client_configuration",
    );

    expect(presentation).toEqual({
      title: "Under maintenance",
      description: "We'll be back shortly. Try again in a moment.",
    });
  });

  test("recognizes typed nested maintenance responses", () => {
    const presentation = bootstrapErrorPresentation(
      new OpenGeniApiError(503, JSON.stringify({ error: { code: "maintenance_mode" } })),
      "workspace_access",
    );

    expect(presentation.title).toBe("Under maintenance");
  });

  test("does not expose proxy HTML or API framing", () => {
    const presentation = bootstrapErrorPresentation(
      new ApiError(502, "<!doctype html><html><body><div>upstream failed</div></body></html>"),
      "client_configuration",
    );

    expect(presentation).toEqual({
      title: "Temporarily unavailable",
      description: "The service could not finish loading. Try again shortly.",
    });
    expect(JSON.stringify(presentation)).not.toContain("<div>");
    expect(JSON.stringify(presentation)).not.toContain("API 502");
  });

  test("explains a successful non-JSON config response without showing parser output", () => {
    const presentation = bootstrapErrorPresentation(
      new SyntaxError("Unexpected token '<', \"<!doctype\" is not valid JSON"),
      "client_configuration",
    );

    expect(presentation).toEqual({
      title: "Couldn't start",
      description:
        "The API returned an invalid configuration response. Check the deployment or proxy configuration, then try again.",
    });
    expect(JSON.stringify(presentation)).not.toContain("Unexpected token");
  });

  test("distinguishes network failures from deployment configuration failures", () => {
    expect(
      bootstrapErrorPresentation(new TypeError("Failed to fetch"), "client_configuration"),
    ).toEqual({
      title: "Can't connect",
      description: "The app could not reach its server. Check your connection and try again.",
    });

    expect(
      bootstrapErrorPresentation(
        new ApiError(500, "internal configuration failure"),
        "client_configuration",
      ),
    ).toEqual({
      title: "Couldn't start",
      description:
        "The client configuration could not be loaded. Check the deployment settings and server logs, then try again.",
    });
  });

  test("keeps workspace-access failures concise", () => {
    const presentation = bootstrapErrorPresentation(
      new ApiError(403, "<div>forbidden by proxy</div>"),
      "workspace_access",
    );

    expect(presentation).toEqual({
      title: "Workspace access unavailable",
      description: "Your workspace access couldn't be loaded. Try again.",
    });
    expect(JSON.stringify(presentation)).not.toContain("forbidden by proxy");
  });
});

describe("bootstrap waiting", () => {
  const parked = () => new OpenGeniApiError(503, JSON.stringify({ error: "maintenance" }));

  test("the maintenance marker is transient in every bootstrap context", () => {
    expect(isTransientBootstrapError(parked(), "client_configuration")).toBe(true);
    expect(isTransientBootstrapError(parked(), "workspace_access")).toBe(true);
    expect(
      isTransientBootstrapError(
        new ApiError(503, JSON.stringify({ error: "maintenance" })),
        "client_configuration",
      ),
    ).toBe(true);
    // A marker on a client error is not an update.
    expect(
      isTransientBootstrapError(
        { status: 403, body: JSON.stringify({ error: "maintenance" }) },
        "client_configuration",
      ),
    ).toBe(false);
  });

  test("an update reads as Updating for as long as it lasts", () => {
    for (const elapsedMs of [0, BOOTSTRAP_CALM_WINDOW_MS * 10]) {
      expect(bootstrapWaitingPresentation(parked(), "client_configuration", elapsedMs)).toEqual({
        title: "Updating",
        description: "This page continues by itself when the update finishes.",
        recovering: true,
      });
    }
  });

  test("another transient failure reconnects calmly, then names the problem", () => {
    const failure = new OpenGeniApiError(502, "", { mutation: false });
    expect(bootstrapWaitingPresentation(failure, "client_configuration", 5_000)).toEqual({
      title: "Reconnecting",
      description: "This page continues by itself when the connection is back.",
      recovering: true,
    });
    expect(
      bootstrapWaitingPresentation(failure, "client_configuration", BOOTSTRAP_CALM_WINDOW_MS),
    ).toEqual({
      ...bootstrapErrorPresentation(failure, "client_configuration"),
      recovering: true,
    });
    const offline = new TypeError("Failed to fetch");
    expect(
      bootstrapWaitingPresentation(offline, "workspace_access", BOOTSTRAP_CALM_WINDOW_MS + 1).title,
    ).toBe("Can't connect");
  });
});
