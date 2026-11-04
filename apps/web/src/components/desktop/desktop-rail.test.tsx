import { describe, expect, test } from "bun:test";
import type { DesktopAccount } from "@opengeni/sdk/desktop-bridge";
import { renderToStaticMarkup } from "react-dom/server";

import { DesktopAccountDetail } from "./desktop-rail";

const staging: DesktopAccount = {
  id: "staging",
  baseUrl: "https://staging.app.opengeni.ai",
  serverLabel: "staging.app.opengeni.ai",
  email: "person@example.com",
  workspaceId: null,
  signedOut: false,
};

describe("the desktop account menu", () => {
  test("marks the account whose page records a meeting", () => {
    const markup = renderToStaticMarkup(
      <DesktopAccountDetail account={{ ...staging, recording: true }} />,
    );
    expect(markup).toContain("staging.app.opengeni.ai");
    expect(markup).toContain("Recording");
  });

  test("says nothing about recording for other accounts or apps that don't say", () => {
    expect(renderToStaticMarkup(<DesktopAccountDetail account={staging} />)).not.toContain(
      "Recording",
    );
    expect(
      renderToStaticMarkup(
        <DesktopAccountDetail account={{ ...staging, signedOut: true, recording: false }} />,
      ),
    ).toContain("staging.app.opengeni.ai · Signed out");
  });
});
