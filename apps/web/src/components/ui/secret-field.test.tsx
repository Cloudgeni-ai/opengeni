import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { Field } from "./field";
import {
  SecretInput,
  importableEnvRows,
  normalizeVariableName,
  parseEnvText,
  summarizeEnvRows,
  variableNameIssue,
} from "./secret-field";

describe("variable names", () => {
  test("normalizes what people type into the saved name", () => {
    expect(normalizeVariableName("pg host-name")).toBe("PG_HOST_NAME");
    expect(normalizeVariableName("  aws.region  ")).toBe("AWS_REGION");
    expect(normalizeVariableName("__dd--api__key__")).toBe("DD_API_KEY");
    expect(normalizeVariableName("")).toBe("");
  });

  test("explains reserved, prefixed, duplicate and malformed names", () => {
    expect(variableNameIssue("GITHUB_TOKEN")).toEqual({
      kind: "reserved",
      message:
        "OpenGeni sets GITHUB_TOKEN for repository access. Use another name, like GITHUB_BOT_TOKEN.",
    });
    expect(variableNameIssue("HOME")?.message).toBe(
      "HOME is set by the sandbox. Use another name.",
    );
    expect(variableNameIssue("OPENGENI_DEBUG")).toEqual({
      kind: "reserved",
      message: "Names starting with OPENGENI_ are reserved. Use another name.",
    });
    expect(variableNameIssue("AWS_REGION", ["AWS_REGION"])?.kind).toBe("duplicate");
    expect(variableNameIssue("9LIVES")?.message).toBe("Start the name with a letter.");
    expect(variableNameIssue("A".repeat(129))?.kind).toBe("invalid");
    expect(variableNameIssue("DATABASE_URL", ["AWS_REGION"])).toBeNull();
    expect(variableNameIssue("")).toBeNull();
  });
});

describe("parseEnvText", () => {
  test("reads comments, export, quotes, inline comments and multi-line values", () => {
    const rows = parseEnvText(
      [
        "# comment",
        "",
        "export DD_SITE=datadoghq.eu # EU site",
        "PGSSLMODE='require'",
        'GREETING="hello \\"agent\\"\\nbye"',
        'PRIVATE_KEY="-----BEGIN KEY-----',
        "abc123",
        '-----END KEY-----"',
        "EMPTY=",
      ].join("\n"),
    );
    expect(rows.map((row) => [row.line, row.name, row.value, row.status])).toEqual([
      [3, "DD_SITE", "datadoghq.eu", "new"],
      [4, "PGSSLMODE", "require", "new"],
      [5, "GREETING", 'hello "agent"\nbye', "new"],
      [6, "PRIVATE_KEY", "-----BEGIN KEY-----\nabc123\n-----END KEY-----", "new"],
      [9, "EMPTY", "", "new"],
    ]);
  });

  test("flags the reserved name and the duplicate from the brief, and keeps the rest", () => {
    const rows = parseEnvText(
      [
        "GITHUB_ORG=acme-robotics",
        "GITHUB_TOKEN=ghp_example",
        "RENOVATE_PLATFORM=github",
        "RENOVATE_AUTODISCOVER=false",
      ].join("\n"),
      ["GITHUB_BOT_TOKEN", "GITHUB_ORG"],
    );
    expect(rows.map((row) => [row.name, row.status])).toEqual([
      ["GITHUB_ORG", "replace"],
      ["GITHUB_TOKEN", "reserved"],
      ["RENOVATE_PLATFORM", "new"],
      ["RENOVATE_AUTODISCOVER", "new"],
    ]);
    expect(rows[0]!.message).toBe("Already in this set. Adding replaces its value.");
    expect(importableEnvRows(rows).map((row) => row.name)).toEqual([
      "GITHUB_ORG",
      "RENOVATE_PLATFORM",
      "RENOVATE_AUTODISCOVER",
    ]);
    expect(summarizeEnvRows(rows)).toBe("2 new · 1 replaces a value · 1 skipped");
  });

  test("keeps the last copy of a repeated name and rejects lines that aren't NAME=value", () => {
    const rows = parseEnvText("region=eu-west-1\nREGION=eu-north-1\njust some text\n=value");
    expect(rows.map((row) => [row.name, row.value, row.status])).toEqual([
      ["REGION", "eu-west-1", "repeated"],
      ["REGION", "eu-north-1", "new"],
      ["just some text", "", "invalid"],
      ["=value", "", "invalid"],
    ]);
    expect(rows[2]!.message).toBe("Line 3 isn't NAME=value.");
    expect(importableEnvRows(rows)).toHaveLength(1);
  });

  test("an unterminated double quote stays on its own line", () => {
    const rows = parseEnvText('A="open\nB=2');
    expect(rows.map((row) => [row.name, row.value])).toEqual([
      ["A", '"open'],
      ["B", "2"],
    ]);
  });
});

describe("SecretInput", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeAll(() => {
    GlobalRegistrator.register();
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  afterAll(() => GlobalRegistrator.unregister());

  test("hides the value until the eye is pressed, and never offers autofill", async () => {
    await act(async () =>
      root.render(
        <Field label="Value" hint="Hidden after you save it.">
          <SecretInput defaultValue="sk_example" />
        </Field>,
      ),
    );
    const input = container.querySelector("input")!;
    const toggle = container.querySelector("button")!;
    expect(input.type).toBe("password");
    expect(input.getAttribute("autocomplete")).toBe("off");
    expect(input.getAttribute("data-1p-ignore")).toBe("true");
    expect(container.querySelector("label")!.htmlFor).toBe(input.id);
    expect(toggle.getAttribute("aria-controls")).toBe(input.id);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.getAttribute("aria-label")).toBe("Show value");

    await act(async () => toggle.click());
    expect(input.type).toBe("text");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.getAttribute("aria-label")).toBe("Hide value");
  });

  test("the multi-line field masks with text security instead of a password type", async () => {
    await act(async () => root.render(<SecretInput multiline aria-label="Value" />));
    const area = container.querySelector("textarea")!;
    expect(area.getAttribute("data-secret-hidden")).toBe("true");
    await act(async () => container.querySelector("button")!.click());
    expect(area.hasAttribute("data-secret-hidden")).toBe(false);
  });
});
