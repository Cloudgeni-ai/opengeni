import { describe, expect, test } from "bun:test";
import {
  otherDeploymentLinkContext,
  otherDeploymentLinks,
  renderSlackSessionDefaultsLine,
} from "../src/integrations/slack-session-defaults";

const workspaceId = "0f9a4c1e-2b3d-4e5f-8a9b-0c1d2e3f4a5b";
const sessionId = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

describe("Slack acknowledgement defaults line", () => {
  test("names connectors, repositories and the environment in one line", () => {
    expect(
      renderSlackSessionDefaultsLine({
        connectors: ["Gmail", "Linear"],
        repositories: ["opengeni"],
        environment: "Build box",
      }),
    ).toBe("Using connectors: Gmail, Linear; repos: opengeni; environment: Build box.");
  });

  test("says none instead of leaving a list out, and omits a missing environment", () => {
    expect(
      renderSlackSessionDefaultsLine({ connectors: [], repositories: [], environment: null }),
    ).toBe("Using connectors: none; repos: none.");
  });

  test("names the first five and counts the rest", () => {
    expect(
      renderSlackSessionDefaultsLine({
        connectors: [],
        repositories: ["a", "b", "c", "d", "e", "f", "g"],
        environment: null,
      }),
    ).toBe("Using connectors: none; repos: a, b, c, d, e and 2 more.");
  });

  test("escapes Slack control characters so a name cannot become a link or mention", () => {
    const line = renderSlackSessionDefaultsLine({
      connectors: ["<!channel> & <https://example.test|click>"],
      repositories: [],
      environment: null,
    });
    expect(line).toContain("&lt;!channel&gt; &amp; &lt;https://example.test|click&gt;");
    expect(line).not.toMatch(/<[^ ]/u);
  });

  test("stays within the stored byte budget without splitting a character or an entity", () => {
    const wide = "界".repeat(200);
    const line = renderSlackSessionDefaultsLine({
      connectors: [wide, wide, wide, wide, wide],
      repositories: ["&".repeat(200), "&".repeat(200)],
      environment: wide,
    });
    expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(480);
    expect(line.endsWith("…")).toBe(true);
    expect(line).not.toContain("�");
    expect(line).not.toMatch(/&[a-z]*…$/u);
    const entities = renderSlackSessionDefaultsLine({
      connectors: [],
      repositories: Array.from({ length: 5 }, () => "&".repeat(47)),
      environment: null,
    });
    expect(Buffer.byteLength(entities, "utf8")).toBeLessThanOrEqual(480);
    expect(entities).not.toMatch(/&[a-z]*…$/u);
  });
});

describe("links to another OpenGeni deployment", () => {
  const production = "https://app.opengeni.ai";

  test("recognizes a sibling deployment under the same parent domain", () => {
    const text = `Look at <https://staging.app.opengeni.ai/workspaces/${workspaceId}/sessions/${sessionId}|this run>`;
    expect(otherDeploymentLinks(text, production)).toEqual([
      {
        url: `https://staging.app.opengeni.ai/workspaces/${workspaceId}/sessions/${sessionId}`,
        host: "staging.app.opengeni.ai",
      },
    ]);
    expect(
      otherDeploymentLinks(
        `https://app.opengeni.ai/workspaces/${workspaceId}`,
        "https://staging.app.opengeni.ai",
      ),
    ).toEqual([
      { url: `https://app.opengeni.ai/workspaces/${workspaceId}`, host: "app.opengeni.ai" },
    ]);
  });

  test("leaves this deployment, unrelated sites and non-OpenGeni routes alone", () => {
    expect(
      otherDeploymentLinks(
        [
          `https://app.opengeni.ai/workspaces/${workspaceId}/sessions/${sessionId}`,
          `https://tracker.example.com/workspaces/${workspaceId}/sessions/${sessionId}`,
          "https://staging.app.opengeni.ai/settings",
          "https://docs.opengeni.ai/guides/slack",
        ].join(" "),
        production,
      ),
    ).toEqual([]);
  });

  test("does nothing without a named web origin", () => {
    const text = `https://staging.app.opengeni.ai/workspaces/${workspaceId}`;
    expect(otherDeploymentLinks(text, undefined)).toEqual([]);
    expect(otherDeploymentLinks(text, "http://127.0.0.1:3000")).toEqual([]);
    expect(otherDeploymentLinks(text, "http://localhost:3000")).toEqual([]);
  });

  test("names each distinct link once", () => {
    const link = `https://staging.app.opengeni.ai/workspaces/${workspaceId}/sessions/${sessionId}`;
    expect(
      otherDeploymentLinks(`${link} and again <${link.toUpperCase()}>`, production),
    ).toHaveLength(1);
  });

  test("tells the agent to name the other deployment instead of reporting not found", () => {
    const context = otherDeploymentLinkContext(
      `https://staging.app.opengeni.ai/workspaces/${workspaceId}/sessions/${sessionId}`,
      production,
    );
    expect(context).toContain("(this one is app.opengeni.ai)");
    expect(context).toContain(
      "Tell the user the link is for staging.app.opengeni.ai, not app.opengeni.ai",
    );
    expect(otherDeploymentLinkContext("no links here", production)).toBeNull();
  });
});
