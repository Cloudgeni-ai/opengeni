import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import { buildAgentCapabilities } from "../src/index";

// The ChatGPT/Codex backend rejects the SDK's HOSTED `apply_patch` tool type
// ("Unsupported tool type: apply_patch", verified live) — but our codex turns run
// the OpenAIResponsesModel, which the SDK's transport detection
// (supportsApplyPatchTransport, keyed off the bound model instance's constructor
// name) reads as hosted-capable. buildAgent threads `structuredToolTransport:
// false` on the codex path so the filesystem capability falls to the FUNCTION
// `apply_patch` the backend accepts. These tests lock that behaviour in AND
// guard that every other backend keeps the SDK default (hosted), by inspecting
// the exact tool the filesystem capability emits once a Responses-style model is
// bound.

// A model instance the SDK reads as hosted-transport-capable: its constructor
// name does NOT contain "ChatCompletions" (so supportsApplyPatchTransport → true,
// exactly like the real OpenAIResponsesModel our codex turns bind).
class OpenAIResponsesModel {}

// The exact bind chain the SandboxAgent runs: clone() a fresh per-run instance,
// then bind → bindRunAs → bindModel, and call tools() on the object the CHAIN
// RETURNS (not the original). Exercising clone() + the chain return is essential:
// a bindModel override that returns the wrong `this` leaves the cloned+bound
// instance out of the chain and makes tools() throw "not bound to a SandboxSession"
// (the live regression this test now guards).
type BindableCap = {
  clone: () => BindableCap;
  bind: (session: unknown) => BindableCap;
  bindRunAs: (r?: unknown) => BindableCap;
  bindModel: (m: string, i?: unknown) => BindableCap;
  tools: () => Array<{ type?: string; name?: string }>;
};

/** Bind a stub sandbox session + a Responses-style model the way SandboxAgent does, return the emitted apply_patch tool's `type`. */
function filesystemApplyPatchToolType(options: Parameters<typeof buildAgentCapabilities>[2]): string | undefined {
  const caps = buildAgentCapabilities(testSettings({ sandboxBackend: "docker" }), [], options);
  const filesystemCap = caps.find((cap) => (cap as { type?: unknown }).type === "filesystem") as unknown as BindableCap;
  // filesystem.tools() only needs createEditor() (truthy) at build time; viewImage
  // is referenced lazily by the view_image tool's execute, never invoked here.
  const stubSession = { createEditor: () => ({}), viewImage: async () => "img" };
  // MUST use the chain's return value (the cloned+bound instance), exactly as the SDK does.
  const bound = filesystemCap.clone().bind(stubSession).bindRunAs(undefined).bindModel("gpt-5.5", new OpenAIResponsesModel());
  return bound.tools().find((tool) => tool.name === "apply_patch")?.type;
}

describe("codex hosted-tool transport: apply_patch", () => {
  test("default (structuredToolTransport unset): a Responses model gets the HOSTED apply_patch — non-codex byte-for-byte unchanged", () => {
    expect(filesystemApplyPatchToolType({})).toBe("apply_patch");
  });

  test("structuredToolTransport:true is the same as the default (explicit opt-in to the SDK default)", () => {
    expect(filesystemApplyPatchToolType({ structuredToolTransport: true })).toBe("apply_patch");
  });

  test("structuredToolTransport:false (codex path): filesystem emits the FUNCTION apply_patch the ChatGPT backend accepts", () => {
    // Was "apply_patch" (hosted) → now "function": the SDK handles its
    // function_call round-trip natively via the same editor, so execution is
    // preserved while the wire tool becomes one the codex backend accepts.
    expect(filesystemApplyPatchToolType({ structuredToolTransport: false })).toBe("function");
  });
});
