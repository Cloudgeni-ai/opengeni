import { expect, mock, test } from "bun:test";

mock.module("@/context", () => ({ useAppContext: () => ({}) }));
const { uploadToKnowledge } = await import("./knowledge-upload");

function client(status = "pending") {
  const calls: string[] = [];
  return {
    calls,
    uploadFile: mock(async (_workspace: string, input: { filename: string; scope: string }) => {
      calls.push(`upload:${input.filename}:${input.scope}`);
      return { id: `file-${input.filename}` };
    }),
    createKnowledgeDrop: mock(
      async (_workspace: string, request: { fileId: string; authorityKind: string }) => {
        calls.push(`prepare:${request.fileId}:${request.authorityKind}`);
        return { status, error: null };
      },
    ),
  };
}

test("a private upload saves the original as private before asking for its text", async () => {
  const api = client();
  await uploadToKnowledge(
    api as never,
    "workspace",
    [new File(["a"], "notes.pdf", { type: "application/pdf" })],
    "personal",
  );
  expect(api.calls).toEqual(["upload:notes.pdf:personal", "prepare:file-notes.pdf:personal"]);
});

test("organization files keep a workspace original and report how many were saved on failure", async () => {
  const api = client("failed");
  const saved: number[] = [];
  await expect(
    uploadToKnowledge(
      api as never,
      "workspace",
      [new File(["a"], "a.txt"), new File(["b"], "b.txt")],
      "organization",
      (count) => saved.push(count),
    ),
  ).rejects.toThrow("a.txt is saved, but its text couldn't be prepared for agents.");
  expect(api.calls).toEqual(["upload:a.txt:workspace", "prepare:file-a.txt:organization"]);
  expect(saved).toEqual([1]);
});
