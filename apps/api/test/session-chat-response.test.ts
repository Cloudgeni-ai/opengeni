import { expect, test } from "bun:test";
import { sessionChatResponse } from "../src/routes/session-chat-response";
import type { Session } from "@opengeni/contracts";

test("chat projection omits operator configuration without mutating the runtime session", () => {
  // Representative reported sizes, not a captured customer's configuration.
  const full = {
    id: "chat",
    title: "Support",
    status: "idle",
    lastSequence: 42,
    instructions: "i".repeat(15_000),
    skills: Array.from({ length: 18 }, (_, index) => ({
      name: `skill-${index}`,
      files: [{ path: "SKILL.md", content: "s".repeat(11_112) }],
    })),
    effectiveTools: { tools: [{ description: "t".repeat(24_000) }] },
    effectiveToolPolicy: { mode: "explicit" },
  } as unknown as Session;
  const original = JSON.stringify(full);
  const chat = sessionChatResponse(full);
  expect(chat).toEqual({
    id: "chat",
    title: "Support",
    status: "idle",
    lastSequence: 42,
    effectiveToolPolicy: { mode: "explicit" },
  });
  expect(Object.keys(chat)).not.toContain("instructions");
  expect(Object.keys(chat)).not.toContain("skills");
  expect(Object.keys(chat)).not.toContain("effectiveTools");
  expect(JSON.stringify(full)).toBe(original);
  console.info(
    JSON.stringify({
      fixture: "18 skills, 15 KB instructions, 24 KB tools",
      beforeBytes: Buffer.byteLength(original),
      afterBytes: Buffer.byteLength(JSON.stringify(chat)),
    }),
  );
});
