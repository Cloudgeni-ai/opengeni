import { expect, test } from "bun:test";
import { generatedImageIds } from "../server/receipts";

const receipt = (artifactId: string) => ({
  type: "agent.toolCall.output",
  payload: {
    output: {
      type: "generated_image",
      artifact: {
        kind: "generated_image",
        sha256: "abc",
        retention: { policy: "workspace_file", expiresAt: null },
        retrieval: { path: `/v1/workspaces/w/artifacts/${artifactId}/content`, method: "GET" },
        artifactId,
        dimensions: { width: 1254, height: 1254 },
      },
    },
  },
});

test("finds receipts whose fields nest objects, in order and without repeats", () => {
  const events = {
    data: [{ type: "turn.started" }, receipt("a-1"), receipt("b-2"), receipt("a-1")],
  };
  expect(generatedImageIds(events)).toEqual(["a-1", "b-2"]);
});

test("ignores other artifacts", () => {
  expect(
    generatedImageIds([{ kind: "file", artifactId: "x" }, { text: "generated_image" }]),
  ).toEqual([]);
});
