import { afterEach, expect, spyOn, test } from "bun:test";
import { UserError } from "@openai/agents-core";
import { Manifest, SandboxProviderError } from "@openai/agents/sandbox";
import {
  classifyProviderSandboxFailure,
  isProviderSandboxGoneDuringRoutedOperation,
} from "../src/sandbox/provider-errors";
import { resumeModalSessionOnSharedClient } from "../src/sandbox/providers/modal-create-session";
import {
  __resetSharedModalClientsForTest,
  sharedModalClient,
} from "../src/sandbox/providers/modal-shared-client";

const defaults = {
  tokenId: "test-resume-id",
  tokenSecret: "test-resume-secret",
  endpoint: "http://127.0.0.1:1",
};
const state = {
  sandboxId: "sb-resume-contract",
  appName: "resume-contract",
  manifest: new Manifest({ root: "/workspace" }),
  environment: {},
  workspacePersistence: "tar" as const,
  ownsSandbox: false,
  imageTag: "test",
  useSleepCmd: false,
} satisfies Parameters<typeof resumeModalSessionOnSharedClient>[1];

afterEach(() => __resetSharedModalClientsForTest());

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("Expected Modal resume to reject");
    },
    (error: unknown) => error,
  );
}

function expectResumeRefusal(error: unknown, message: string, kind: "other" | "not_found") {
  const legacy = new UserError(message);
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(SandboxProviderError);
  expect(error).toMatchObject({ name: legacy.name, message: legacy.message });
  expect((error as { code?: unknown }).code).toBeUndefined();
  // Callers classify the exact terminal message, not the agent-loop prototype.
  expect(classifyProviderSandboxFailure("modal", error)).toEqual(
    classifyProviderSandboxFailure("modal", legacy),
  );
  expect(classifyProviderSandboxFailure("modal", error).kind).toBe(kind);
  expect(isProviderSandboxGoneDuringRoutedOperation("modal", error)).toBe(
    isProviderSandboxGoneDuringRoutedOperation("modal", legacy),
  );
}

test("missing Modal resume identity keeps the user-error shape without calling the provider", async () => {
  const fromId = spyOn(sharedModalClient(defaults).sandboxes, "fromId").mockRejectedValue(
    new Error("provider must not be called"),
  );
  try {
    const error = await rejection(
      resumeModalSessionOnSharedClient(defaults, { ...state, sandboxId: undefined }),
    );
    expectResumeRefusal(error, "Modal sandbox resume requires a persisted sandboxId.", "other");
    expect(fromId).not.toHaveBeenCalled();
  } finally {
    fromId.mockRestore();
  }
});

test("a stopped Modal sandbox keeps terminal-loss classification after its exact poll", async () => {
  let polls = 0;
  const fromId = spyOn(sharedModalClient(defaults).sandboxes, "fromId").mockResolvedValue({
    poll: async () => {
      polls++;
      return 0;
    },
  } as never);
  try {
    const error = await rejection(resumeModalSessionOnSharedClient(defaults, state));
    expectResumeRefusal(
      error,
      "Modal sandbox sb-resume-contract is no longer running.",
      "not_found",
    );
    expect(fromId).toHaveBeenCalledTimes(1);
    expect(fromId).toHaveBeenCalledWith(state.sandboxId);
    expect(polls).toBe(1);
  } finally {
    fromId.mockRestore();
  }
});

test.each([14, 404])("Modal lookup failure retains provider cause/code %i", async (code) => {
  const cause = Object.assign(new Error("lookup failed"), { code });
  const fromId = spyOn(sharedModalClient(defaults).sandboxes, "fromId").mockRejectedValue(cause);
  try {
    const error = await rejection(resumeModalSessionOnSharedClient(defaults, state));
    expect(error).toBeInstanceOf(SandboxProviderError);
    expect((error as Error).cause).toBe(cause);
    expect((error as { code: string }).code).toBe("provider_error");
    expect(classifyProviderSandboxFailure("modal", error)).toEqual({
      kind: code === 14 ? "transient_transport" : "not_found",
      diagnostic: `code=PROVIDER_ERROR status=${code}`,
    });
    expect(isProviderSandboxGoneDuringRoutedOperation("modal", error)).toBe(false);
  } finally {
    fromId.mockRestore();
  }
});
