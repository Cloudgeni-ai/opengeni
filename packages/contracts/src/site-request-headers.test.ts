import { expect, test } from "bun:test";
import { siteRequestHeaders } from "./site-session-http";

test("Site forwarding preserves application headers and removes host authority and transport", () => {
  const input = {
    range: "bytes=0-1023",
    "if-match": '"version"',
    "idempotency-key": "operation",
    "x-opengeni-chunk-sha256": "digest",
    "x-custom-option": "value",
    authorization: "forged",
    cookie: "session=forged",
    "x-opengeni-access-key": "forged",
    "x-opengeni-external-actor": "forged",
    "x-opengeni-site-id": "forged",
    connection: "x-private-hop",
    "x-private-hop": "transport",
    "content-length": "999",
  };
  const headers = siteRequestHeaders(input);
  expect(Object.fromEntries(headers)).toEqual({
    range: "bytes=0-1023",
    "if-match": '"version"',
    "idempotency-key": "operation",
    "x-opengeni-chunk-sha256": "digest",
    "x-custom-option": "value",
  });
});
