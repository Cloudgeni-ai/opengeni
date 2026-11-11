import { describe, expect, mock, test } from "bun:test";
import { electronStub } from "./electron-stub";

mock.module("electron", () => electronStub);
const { DesktopShell } = await import("../src/main/app");

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

describe("the app's own API requests", () => {
  test("go with the account window's cookies, so a renewed sign-in reaches the window", async () => {
    const calls: { via: string; input: string; init?: RequestInit }[] = [];
    (electronStub.session as Record<string, unknown>).fromPartition = (partition: string) => ({
      fetch: async (input: string, init?: RequestInit) => {
        calls.push({ via: partition, input, ...(init ? { init } : {}) });
        return new Response("{}");
      },
    });
    (electronStub.net as Record<string, unknown>).fetch = async (
      input: string,
      init?: RequestInit,
    ) => {
      calls.push({ via: "net", input, ...(init ? { init } : {}) });
      return new Response("{}");
    };
    const shell = Object.create(DesktopShell.prototype) as {
      clientOptions(
        baseUrl: string,
        token?: string,
        accountId?: string,
      ): { fetch: Fetch; apiKey?: string };
    };

    const account = shell.clientOptions("https://app.example.test", "ogapp_x", "a1");
    expect(account.apiKey).toBe("ogapp_x");
    await account.fetch("https://app.example.test/v1/inbox", { method: "GET" });
    expect(calls.at(-1)).toMatchObject({
      via: "persist:account-a1",
      init: { method: "GET", credentials: "include" },
    });

    // A request that chose its own credentials mode keeps it.
    await account.fetch("https://app.example.test/v1/inbox", { credentials: "omit" });
    expect(calls.at(-1)?.init?.credentials).toBe("omit");

    // Before any account exists (the sign-in exchange), nothing is shared.
    const anonymous = shell.clientOptions("https://app.example.test");
    await anonymous.fetch("https://app.example.test/v1/native-app/token");
    expect(calls.at(-1)?.via).toBe("net");
  });
});
