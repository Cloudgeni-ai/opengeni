import { expect, test } from "bun:test";
import { CODEX_CLIENT_VERSION, CODEX_ORIGINATOR } from "../src/constants";
import { fetchCodexModels } from "../src/api-client";

test("reviewed client version reaches discovery query and transport identity together", async () => {
  expect(CODEX_CLIENT_VERSION).toBe("0.156.0");
  const result = await fetchCodexModels(
    {
      accessToken: "synthetic",
      chatgptAccountId: "synthetic-account",
      isFedramp: false,
      clientVersion: CODEX_CLIENT_VERSION,
    },
    async (input, init) => {
      expect(new URL(String(input)).searchParams.get("client_version")).toBe("0.156.0");
      const headers = new Headers(init?.headers);
      expect(headers.get("version")).toBe("0.156.0");
      expect(headers.get("user-agent")).toBe(`${CODEX_ORIGINATOR}/0.156.0`);
      expect(headers.get("chatgpt-account-id")).toBe("synthetic-account");
      return Response.json({ models: [{ slug: "synthetic-model" }] });
    },
  );
  expect(result).toEqual({ ok: true, status: 200, slugs: ["synthetic-model"] });
});
