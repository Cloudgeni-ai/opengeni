import { describe, expect, test } from "bun:test";
import { OpenGeniClient } from "@opengeni/sdk/artifacts";
import type { OpenedEditableArtifact } from "@opengeni/react/artifacts";
import { downloadEditableArtifact } from "./editable-artifact-download";

const MIME = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
} as const;

function fixture(mime: string) {
  const calls: { path: string; body: any }[] = [];
  const client = new OpenGeniClient({
    baseUrl: "https://api.example.test",
    apiKey: "test-only",
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (path.endsWith("/versions")) return Response.json({ id: "pinned", headSequence: 3 });
      if (path.endsWith("/download"))
        return new Response(new Uint8Array([80, 75, 3, 4]), { headers: { "content-type": mime } });
      return Response.json({ id: "job", state: "succeeded", result: { mimeType: mime } });
    },
  });
  return { client, calls };
}

describe("editable artifact Office download", () => {
  for (const [modality, format] of [
    ["document", "docx"],
    ["spreadsheet", "xlsx"],
    ["presentation", "pptx"],
  ] as const) {
    test(`${modality} exports the pinned head as ${format}`, async () => {
      const { client, calls } = fixture(MIME[format]);
      const opened = {
        artifact: { id: "artifact", modality, headSequence: 1 },
        replicaId: "replica",
      } as OpenedEditableArtifact;
      const blob = await downloadEditableArtifact(
        client,
        "workspace",
        opened,
        new AbortController().signal,
      );
      expect(calls.map((call) => call.path.split("/").pop())).toEqual([
        "versions",
        "materializations",
        "download",
      ]);
      expect(calls[0]!.body).toMatchObject({ name: `${format.toUpperCase()} download` });
      expect(calls[1]!.body).toMatchObject({ versionId: "pinned", format, replicaId: "replica" });
      expect(blob.type).toBe(MIME[format]);
    });
  }
});
