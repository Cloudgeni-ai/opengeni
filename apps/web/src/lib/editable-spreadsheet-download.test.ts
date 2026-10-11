import { describe, expect, test } from "bun:test";
import { OpenGeniClient } from "@opengeni/sdk/artifacts";
import type { OpenedEditableArtifact } from "@opengeni/react/artifacts";
import { downloadSpreadsheet } from "./editable-spreadsheet-download";

const opened = {
  artifact: { id: "artifact", modality: "spreadsheet", headSequence: 1 },
  replicaId: "replica",
} as OpenedEditableArtifact;
const mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function fixture(states = ["succeeded"], failure?: number) {
  const calls: { path: string; body: any; signal: AbortSignal | null | undefined }[] = [];
  const client = new OpenGeniClient({
    baseUrl: "https://api.example.test",
    apiKey: "test-only",
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ path, body, signal: init?.signal });
      if (failure) return new Response("Denied", { status: failure });
      if (path.endsWith("/versions"))
        return Response.json({ id: "pinned-current-head", headSequence: 9 });
      if (path.endsWith("/download"))
        return new Response(new Uint8Array([80, 75, 3, 4]), { headers: { "content-type": mime } });
      const state = states.length > 1 ? states.shift() : states[0];
      return Response.json({
        id: "job",
        state,
        result: state === "succeeded" ? { mimeType: mime } : null,
      });
    },
  });
  return { client, calls };
}

describe("native spreadsheet download", () => {
  test("pins the current head, polls XLSX and downloads only the resulting job", async () => {
    const { client, calls } = fixture(["pending", "succeeded"]);
    const abort = new AbortController();
    const blob = await downloadSpreadsheet(client, "workspace", opened, abort.signal);
    expect(calls.map((call) => call.path.split("/").pop())).toEqual([
      "versions",
      "materializations",
      "job",
      "download",
    ]);
    expect(calls[1]!.body).toMatchObject({
      versionId: "pinned-current-head",
      format: "xlsx",
      replicaId: "replica",
    });
    expect(calls.every((call) => call.signal != null)).toBe(true);
    expect(blob.type).toBe(mime);
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([80, 75, 3, 4]);
  });
  test("export failure and permission denial never download", async () => {
    for (const scenario of [fixture(["failed"]), fixture([], 403)]) {
      await expect(
        downloadSpreadsheet(scenario.client, "workspace", opened, new AbortController().signal),
      ).rejects.toThrow();
      expect(scenario.calls.some((call) => call.path.endsWith("/download"))).toBe(false);
    }
  });
  test("cancellation stops polling and never downloads", async () => {
    const { client, calls } = fixture(["running"]);
    const abort = new AbortController();
    const result = downloadSpreadsheet(client, "workspace", opened, abort.signal);
    setTimeout(() => abort.abort(), 10);
    await expect(result).rejects.toThrow();
    expect(calls).toHaveLength(2);
  });
  test("unsupported modalities fail before any request", async () => {
    const { client, calls } = fixture();
    await expect(
      downloadSpreadsheet(
        client,
        "workspace",
        { ...opened, artifact: { ...opened.artifact, modality: "document" } },
        new AbortController().signal,
      ),
    ).rejects.toThrow("Only XLSX");
    expect(calls).toHaveLength(0);
  });
});
