import { describe, expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import { assertOpaqueKickoff, createVerificationClient, main } from "./verify-portable-compaction";
import {
  CompactionVerificationError,
  verificationFailureDiagnostics,
} from "./compaction-verification-errors";
import { compactDurableFixture } from "./compaction-durable";
import { compactionHistoryFixture } from "./compaction-history";

describe("portable compaction operator verification", () => {
  test("requires live opt-in and reports actionable local assertions without provider content", async () => {
    await expect(main([])).rejects.toThrow("Pass --live");
    expect(
      verificationFailureDiagnostics(
        new CompactionVerificationError("Checkpoint verification failed."),
      ),
    ).toEqual({ verificationFailed: true, message: "Checkpoint verification failed." });
    const diagnostics = verificationFailureDiagnostics(
      Object.assign(new Error("private provider conversation"), {
        status: 400,
        cause: new Error("Bearer private-credential"),
      }),
    );
    expect(diagnostics).toMatchObject({ verificationFailed: true, httpStatus: 400 });
    expect(JSON.stringify(diagnostics)).not.toMatch(/private|Bearer|conversation/);
  });

  test("rejects a vacuous kickoff containing plaintext reasoning only", () => {
    const message = { type: "message", role: "assistant" };
    for (const reasoning of [
      { type: "reasoning", summary: [{ type: "summary_text", text: "plain" }] },
      { type: "reasoning", encrypted_content: "" },
    ])
      expect(() => assertOpaqueKickoff([reasoning, message])).toThrow("opaque reasoning");
    expect(() =>
      assertOpaqueKickoff([{ type: "reasoning", encrypted_content: "opaque" }, message]),
    ).not.toThrow();
  });

  test("uses the runtime client for both Azure base-URL and endpoint/deployment configurations", () => {
    const base = testSettings({ openaiProvider: "azure", azureOpenaiApiKey: "synthetic-key" });
    const v1 = createVerificationClient({
      ...base,
      azureOpenaiBaseUrl: "https://fixture.invalid/openai/v1",
    });
    expect(v1.baseURL).toBe("https://fixture.invalid/openai/v1");
    const deployment = createVerificationClient({
      ...base,
      azureOpenaiBaseUrl: undefined,
      azureOpenaiEndpoint: "https://fixture.invalid/",
      azureOpenaiDeployment: "fixture",
      azureOpenaiApiKey: undefined,
      azureOpenaiAdToken: "synthetic-ad-token",
    });
    expect(deployment.baseURL).toBe("https://fixture.invalid/openai/deployments/fixture");
    expect(() =>
      createVerificationClient({
        ...base,
        azureOpenaiBaseUrl: undefined,
        azureOpenaiEndpoint: undefined,
        azureOpenaiDeployment: undefined,
      }),
    ).toThrow("Configure Azure");
  });

  test("installs the canary checkpoint through the real fenced activity and preserves every archived row", async () => {
    const history = compactionHistoryFixture();
    const before = structuredClone(history);
    const result = await compactDurableFixture(
      testSettings(),
      history,
      async () => "Fixture release is blue. Inspection and patch completed. Continue verification.",
    );
    expect(result.proof).toMatchObject({
      archivedItems: history.length,
      archivedHistoryUnchanged: true,
      tokenSignalCleared: true,
      compactionRequestConsumed: true,
      durableCompactionEvent: true,
    });
    expect(result.replacement.at(-1)).toMatchObject({ opengeni_context_summary: true });
    expect(history).toEqual(before);
  }, 180_000);
});
