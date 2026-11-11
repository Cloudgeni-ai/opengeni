import { expect, test } from "bun:test";
import { destinationLoadFailureReason } from "../src/cdp-driver";

test("names page load errors that are the website's own", () => {
  for (const [errorText, reason] of [
    ["net::ERR_NAME_NOT_RESOLVED", "destination_name_not_resolved"],
    ["net::ERR_CONNECTION_REFUSED", "destination_connection_failed"],
    ["net::ERR_CONNECTION_RESET", "destination_connection_failed"],
    ["net::ERR_CONNECTION_TIMED_OUT", "destination_connection_failed"],
    ["net::ERR_ADDRESS_UNREACHABLE", "destination_connection_failed"],
    ["net::ERR_CERT_AUTHORITY_INVALID", "destination_tls_failed"],
    ["net::ERR_CERT_DATE_INVALID", "destination_tls_failed"],
    ["net::ERR_CERTIFICATE_TRANSPARENCY_REQUIRED", "destination_tls_failed"],
    ["net::ERR_SSL_PROTOCOL_ERROR", "destination_tls_failed"],
    ["net::ERR_SSL_VERSION_OR_CIPHER_MISMATCH", "destination_tls_failed"],
    ["net::ERR_BAD_SSL_CLIENT_AUTH_CERT", "destination_tls_failed"],
    ["net::ERR_EMPTY_RESPONSE", "destination_response_invalid"],
    ["net::ERR_TOO_MANY_REDIRECTS", "destination_response_invalid"],
    ["net::ERR_INVALID_HTTP_RESPONSE", "destination_response_invalid"],
  ] as const)
    expect(destinationLoadFailureReason(errorText), errorText).toBe(reason);
});

test("leaves errors that can be the browser's or its network's as ours", () => {
  for (const errorText of [
    "net::ERR_PROXY_CONNECTION_FAILED",
    "net::ERR_TUNNEL_CONNECTION_FAILED",
    "net::ERR_INTERNET_DISCONNECTED",
    "net::ERR_NETWORK_CHANGED",
    "net::ERR_NETWORK_ACCESS_DENIED",
    "net::ERR_NAME_RESOLUTION_FAILED",
    "net::ERR_BLOCKED_BY_CLIENT",
    "net::ERR_BLOCKED_BY_ADMINISTRATOR",
    "net::ERR_ABORTED",
    "net::ERR_FAILED",
    "net::ERR_CERT",
    "ERR_NAME_NOT_RESOLVED",
    "",
  ])
    expect(destinationLoadFailureReason(errorText), errorText).toBeUndefined();
});
