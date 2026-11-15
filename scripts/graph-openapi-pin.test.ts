import { expect, test } from "bun:test";

import {
  CORE_INTEGRATION_DEFINITIONS,
  MICROSOFT_GRAPH_OPENAPI_PIN,
  MICROSOFT_OUTLOOK_MAIL_INTEGRATION_DEFINITION,
} from "../packages/capabilities/src";
import { missingReviewedOperations, pinDefinitionDiff } from "./graph-openapi-pin";

test("every Microsoft Graph built-in reads one commit-pinned document with its digest", () => {
  expect(MICROSOFT_GRAPH_OPENAPI_PIN.url).toMatch(
    /^https:\/\/raw\.githubusercontent\.com\/microsoftgraph\/msgraph-metadata\/[0-9a-f]{40}\/openapi\/v1\.0\/openapi\.yaml$/,
  );
  expect(MICROSOFT_GRAPH_OPENAPI_PIN.sha256).toMatch(/^[0-9a-f]{64}$/);
  for (const definition of CORE_INTEGRATION_DEFINITIONS) {
    if (definition.provider.id !== "microsoft" || definition.source.kind !== "openapi") continue;
    expect(definition.source.pinned).toEqual(MICROSOFT_GRAPH_OPENAPI_PIN);
  }
});

test("the pin diff names lost reviewed operations and generic scope changes", () => {
  const ok = { responses: { "200": { description: "OK" } } };
  const current = {
    paths: {
      "/me/messages": { get: ok, post: ok },
      "/me/messages/{message-id}": { get: ok },
      "/me/mailFolders/delta()": { get: ok },
      "/users": { get: ok },
    },
  };
  const candidate = {
    paths: {
      "/me/messages": { get: ok },
      "/me/messages/{message-id}": { get: ok },
      "/me/mailFolders/{mailFolder-id}/messageRules": { get: ok },
      "/users/{user-id}": { get: ok },
    },
  };
  const diff = pinDefinitionDiff(current, candidate, MICROSOFT_OUTLOOK_MAIL_INTEGRATION_DEFINITION);
  expect(diff.missingReviewed).toContain("POST /me/messages");
  expect(diff.missingReviewed).not.toContain("GET /me/messages");
  expect(diff.scopeAdded).toEqual(["GET /me/mailFolders/{mailFolder-id}/messageRules"]);
  expect(diff.scopeRemoved).toEqual(["GET /me/mailFolders/delta()", "POST /me/messages"]);
  expect(
    missingReviewedOperations(candidate, MICROSOFT_OUTLOOK_MAIL_INTEGRATION_DEFINITION),
  ).toEqual(diff.missingReviewed);
});
