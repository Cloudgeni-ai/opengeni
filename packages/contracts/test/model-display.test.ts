import { describe, expect, test } from "bun:test";
import {
  humanizeModelSlug,
  isRawModelLabel,
  modelDisplayName,
  modelVendor,
} from "../src/model-display";

describe("modelDisplayName", () => {
  test("strips routing prefixes from raw ids", () => {
    expect(modelDisplayName("codex/gpt-6.1-sol")).toBe("GPT-6.1 Sol");
    expect(modelDisplayName("organization-claude-subscription/claude-opus-5-5")).toBe(
      "Claude Opus 5.5",
    );
    expect(modelDisplayName("workspace-claude-subscription/claude-opus-5-5")).toBe(
      "Claude Opus 5.5",
    );
    expect(modelDisplayName("gpt-6-luna")).toBe("GPT-6 Luna");
    expect(modelDisplayName("supergrok/grok-4.7")).toBe("Grok 4.7");
    expect(modelDisplayName("workspace-openrouter/anthropic/claude-sonnet-4.6")).toBe(
      "Claude Sonnet 4.6",
    );
    expect(modelDisplayName("workspace-openrouter/nvidia/nemotron-3-super-120b-a12b:free")).toBe(
      "Nemotron 3 Super 120B A12B",
    );
    expect(modelDisplayName("organization-anthropic/claude-haiku-4-5-20251001")).toBe(
      "Claude Haiku 4.5",
    );
  });

  test("org- and workspace-connected copies render identically", () => {
    const org = {
      id: "organization-claude-subscription/claude-opus-4-8",
      label: "claude-opus-4-8",
      deployment: { upstreamModelId: "claude-opus-4-8" },
    };
    const workspace = {
      id: "workspace-claude-subscription/claude-opus-4-8",
      label: "claude-opus-4-8",
    };
    expect(modelDisplayName(org)).toBe("Claude Opus 4.8");
    expect(modelDisplayName(workspace)).toBe(modelDisplayName(org));
  });

  test("keeps names that are already readable", () => {
    expect(modelDisplayName("Workspace default")).toBe("Workspace default");
    expect(modelDisplayName("")).toBe("");
  });

  test("keeps curated labels", () => {
    expect(modelDisplayName({ id: "codex/gpt-6.1-sol", label: "GPT-6.1 Sol" })).toBe("GPT-6.1 Sol");
    expect(modelDisplayName({ id: "x/glm-5p2", label: "GLM 5.2" })).toBe("GLM 5.2");
    expect(modelDisplayName({ id: "gpt-5.6", label: "GPT-5.6" })).toBe("GPT-5.6");
    expect(modelDisplayName({ id: "o3", label: "o3" })).toBe("o3");
    expect(
      modelDisplayName({
        id: "workspace-gateway/anthropic/claude-sonnet-4.6",
        label: "team-sonnet",
      }),
    ).toBe("team-sonnet");
    expect(
      modelDisplayName({
        id: "workspace-gateway/anthropic/claude-sonnet-4.6",
        label: "Sonnet (team)",
      }),
    ).toBe("Sonnet (team)");
  });

  test("humanizes common families", () => {
    expect(humanizeModelSlug("gpt-4o-mini")).toBe("GPT-4o Mini");
    expect(humanizeModelSlug("o4-mini")).toBe("o4 Mini");
    expect(humanizeModelSlug("claude-3-5-sonnet-latest")).toBe("Claude 3.5 Sonnet");
    expect(humanizeModelSlug("gemini-2.5-pro")).toBe("Gemini 2.5 Pro");
    expect(humanizeModelSlug("deepseek-v4-flash")).toBe("DeepSeek V4 Flash");
    expect(humanizeModelSlug("kimi-k3")).toBe("Kimi K3");
    expect(humanizeModelSlug("grok-code-fast-1")).toBe("Grok Code Fast 1");
  });

  test("a label is raw only when it is the id, upstream id or their slug", () => {
    const id = "workspace-openrouter/anthropic/claude-sonnet-4.6";
    expect(isRawModelLabel("anthropic/claude-sonnet-4.6", [id])).toBe(true);
    expect(isRawModelLabel("claude-sonnet-4.6", [id])).toBe(true);
    expect(isRawModelLabel("claude-opus-4-8", [null, "claude-opus-4-8"])).toBe(true);
    expect(isRawModelLabel("", [id])).toBe(true);
    // Custom labels win even when they look like slugs.
    expect(isRawModelLabel("team-sonnet", [id])).toBe(false);
    expect(isRawModelLabel("GPT-6.1 Sol", ["codex/gpt-6.1-sol"])).toBe(false);
  });

  test("snapshot numbers are not minor versions", () => {
    expect(humanizeModelSlug("gpt-4-1106-preview")).toBe("GPT-4 1106 Preview");
    expect(humanizeModelSlug("gpt-4o-2024-08-06")).toBe("GPT-4o");
  });
});

describe("modelVendor", () => {
  test("names the model maker independent of the connection", () => {
    expect(modelVendor("codex/gpt-6.1-sol")).toBe("openai");
    expect(modelVendor("gpt-6-luna")).toBe("openai");
    expect(modelVendor("organization-claude-subscription/claude-opus-5-5")).toBe("anthropic");
    expect(modelVendor("workspace-anthropic/claude-opus-5-5")).toBe("anthropic");
    expect(modelVendor("workspace-openrouter/anthropic/claude-sonnet-4.6")).toBe("anthropic");
    expect(modelVendor("supergrok/grok-4.7")).toBe("xai");
    expect(modelVendor("workspace-gateway/kimi-k3")).toBe("moonshot");
    expect(modelVendor({ id: "fireworks/custom", label: "Gemini 3 Pro" })).toBe("google");
    expect(modelVendor("opencode/muse-spark-1.3")).toBeNull();
  });
});
