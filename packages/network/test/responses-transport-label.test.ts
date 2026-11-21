import { expect, test } from "bun:test";
import {
  MODEL_TRANSPORT_HEADER,
  disabledResponsesTransport,
  parseModelRequestTransport,
  responsesTransport,
} from "../src/responses-websocket";

test("a disabled socket transport labels every response http; reason=disabled", async () => {
  const fetch = disabledResponsesTransport(async () => new Response("ok"));
  const response = await fetch("https://api.example.test/v1/responses", { method: "POST" });
  expect(parseModelRequestTransport(response.headers.get(MODEL_TRANSPORT_HEADER))).toEqual({
    kind: "http",
    reason: "disabled",
  });
  expect(await response.text()).toBe("ok");
});

test("a request the socket does not carry is labelled not_eligible", async () => {
  const fetch = responsesTransport(async () => new Response("plain"), {
    createSocket: () => {
      throw new Error("no socket for this request");
    },
    endpoint: { url: /\/v1\/responses$/ } as never,
  });
  const response = await fetch("https://api.example.test/v1/models", { method: "GET" });
  expect(parseModelRequestTransport(response.headers.get(MODEL_TRANSPORT_HEADER))).toEqual({
    kind: "http",
    reason: "not_eligible",
  });
});
