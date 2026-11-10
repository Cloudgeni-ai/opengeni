import { expect, test } from "bun:test";
import {
  OpenGeniClient,
  type Session,
  type ChatSession,
  type SessionListResponse,
  type SessionLineageResponse,
} from "../src/index";
import type { CreateSessionResponse } from "../src/types";
import { OpenGeniBrowserClient } from "../src/browser";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
test("default SDK response types stay full and explicit chat clients carry compact types", () => {
  const full = new OpenGeniClient({ baseUrl: "https://api.test" });
  const chat = new OpenGeniClient({ baseUrl: "https://api.test" }).withSessionResponse("chat");
  const browser = new OpenGeniBrowserClient({
    baseUrl: "https://api.test",
  }).withSessionResponse("chat");
  const clone = full.asUser("person").withSessionResponse("chat");
  const attributed = chat.withHeaders({}).asUser("person");
  const assertions: [
    Equal<Awaited<ReturnType<typeof full.getSession>>, Session>,
    Equal<Awaited<ReturnType<typeof full.createSession>>, CreateSessionResponse>,
    Equal<Awaited<ReturnType<typeof full.listSessionPage>>, SessionListResponse>,
    Equal<Awaited<ReturnType<typeof full.getSessionLineage>>, SessionLineageResponse>,
    Equal<Awaited<ReturnType<typeof chat.getSession>>, ChatSession>,
    Equal<Awaited<ReturnType<typeof browser.getSession>>, ChatSession>,
    Equal<Awaited<ReturnType<typeof clone.getSession>>, ChatSession>,
    Equal<Awaited<ReturnType<typeof chat.getSessionConfiguration>>, Session>,
    Equal<Awaited<ReturnType<typeof chat.updateSessionAgent>>, ChatSession>,
    Equal<Awaited<ReturnType<typeof attributed.getSession>>, ChatSession>,
  ] = [true, true, true, true, true, true, true, true, true, true];
  expect(assertions.every(Boolean)).toBe(true);
});
