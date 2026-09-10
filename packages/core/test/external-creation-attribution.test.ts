import { expect, test } from "bun:test";
import type { AccessContext, AccessGrant } from "@opengeni/contracts";
import {
  accessGrantAuthorizationFromContext,
  externalAttributionForAuthorization,
  isVerifiedOrganizationServiceAuthorization,
} from "../src/access";
import {
  externalCreationMetadata,
  EXTERNAL_CREATION_ATTRIBUTION_KEY,
} from "../src/domain/external-creation-attribution";

const grant: AccessGrant = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  subjectId: "external_user:33333333-3333-4333-8333-333333333333",
  permissions: ["sessions:create"],
  principalKind: "human_session",
  metadata: { externalActor: { authenticatingApiKeyId: "forged" } },
};

test("service proof rejects absent and fabricated grants", () => {
  expect(isVerifiedOrganizationServiceAuthorization({} as never)).toBe(false);
  expect(isVerifiedOrganizationServiceAuthorization({ grant } as never)).toBe(false);
});

test("external-looking grant metadata cannot mint creation attribution", () => {
  const context: AccessContext = {
    mode: "configured",
    subjectId: grant.subjectId,
    defaultAccountId: grant.accountId,
    defaultWorkspaceId: grant.workspaceId,
    workspaceGrants: [grant],
    accountGrants: [{ accountId: grant.accountId, subjectId: grant.subjectId, permissions: [] }],
  };
  const authorization = accessGrantAuthorizationFromContext(context, grant);
  expect(authorization.contextIntegrity).toBe(true);
  expect(externalAttributionForAuthorization(authorization, grant)).toBeNull();
  expect(externalCreationMetadata({ custom: "retained" }, authorization, grant)).toEqual({
    custom: "retained",
  });
});

test("caller metadata cannot impersonate the reserved server creation audit", () => {
  expect(() =>
    externalCreationMetadata(
      { [EXTERNAL_CREATION_ATTRIBUTION_KEY]: { authenticatingApiKeyId: "forged" } },
      undefined,
      grant,
    ),
  ).toThrow("server-owned");
  expect(externalCreationMetadata(undefined, undefined, grant)).toBeUndefined();
});
