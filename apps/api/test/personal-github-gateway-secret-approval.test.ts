import { describe, expect, test } from "bun:test";
import type { PersonalGitHubGitBrokerClaims } from "@opengeni/github";
import { randomBytes } from "node:crypto";
import {
  handlePersonalGitHubGatewayRequest,
  type PersonalGitHubGatewayAuthority,
  type PersonalGitHubGatewayServices,
} from "../src/routes/personal-github-gateway";
import type { GatewayDecisionInput } from "../src/routes/personal-github-gateway-policy";

// `gh secret set` seals the value with a fresh ephemeral key on every run, so
// the same command sends a different `encrypted_value` each time. An approval
// of the first try must match the retry, and nothing else.

const claims = { connectionId: "connection-1" } as unknown as PersonalGitHubGitBrokerClaims;
const permissions = { pull: true, triage: false, push: true, maintain: false, admin: false };

function selected(fullName: string, id: string) {
  return {
    repositoryId: id,
    fullName,
    canonicalUrl: `https://github.com/${fullName}`,
    selectedAccess: "write",
    selectionGeneration: 1,
    permissions,
    archived: false,
    disabled: false,
  };
}

const authority: PersonalGitHubGatewayAuthority = {
  claims,
  identity: { claims, initiator: { kind: "human", subjectId: "person" }, unattended: false },
  providerPrincipalId: "7",
  metadata: {
    credentialBindingId: "00000000-0000-4000-8000-000000000001",
    providerPrincipalId: "7",
    githubUserId: "7",
    githubLogin: "person",
  } as PersonalGitHubGatewayAuthority["metadata"],
  selection: {
    connectionAuthorityGeneration: 1,
    credentialBindingId: "00000000-0000-4000-8000-000000000001",
    providerPrincipalId: "7",
    selectionGeneration: 1,
    allRepositoriesAccess: "write",
    repositories: [selected("acme/ops", "11"), selected("acme/widgets", "12")],
  } as unknown as PersonalGitHubGatewayAuthority["selection"],
  removedRepositories: [],
};

function harness() {
  const decisions: GatewayDecisionInput[] = [];
  const services: PersonalGitHubGatewayServices = {
    openClaims: (token) => (token === "session-pass" ? claims : null),
    resolveAuthority: async () => authority,
    authorizeProviderRequest: async () => "Bearer person-token",
    decide: async (_identity, input) => {
      decisions.push(input);
      return { kind: "refuse", status: 403, waiting: true, message: "Waiting for approval" };
    },
    complete: async () => undefined,
    git: {} as PersonalGitHubGatewayServices["git"],
    fetch: (async () => Response.json({ ok: true })) as unknown as typeof fetch,
  };
  const put = async (path: string, body: unknown) => {
    const before = decisions.length;
    await handlePersonalGitHubGatewayRequest(
      new Request(`https://opengeni.test/v1/github/personal/gateway/api${path}`, {
        method: "PUT",
        headers: { authorization: "Bearer session-pass", "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      "api",
      services,
    );
    expect(decisions).toHaveLength(before + 1);
    return decisions[before]!;
  };
  return { put };
}

/** What `gh secret set` sends: a new sealed box, and the key ID it fetched. */
function sealed(extra: Record<string, unknown> = {}, keyId = "568250167242549743") {
  return { encrypted_value: randomBytes(72).toString("base64"), key_id: keyId, ...extra };
}

const ENV_SECRET = "/repos/acme/ops/environments/staging/secrets/SLACK_WEBHOOK_URL";

describe("approvals of secret writes", () => {
  test("a re-sealed retry of the same environment secret has the approved request's digest", async () => {
    const { put } = harness();
    const first = await put(ENV_SECRET, sealed());
    const retry = await put(ENV_SECRET, sealed({}, "3380204578043523366"));
    expect(first.title).toBe("Change repository environments on acme/ops");
    expect(retry.digest).toBe(first.digest);
    // The approval ledger also fingerprints what the card shows: it must not
    // carry the ciphertext either, or the retry conflicts with its approval.
    expect(retry.reviewArguments).toEqual(first.reviewArguments);
    expect(first.reviewArguments).toEqual({
      request: `PUT ${ENV_SECRET}`,
      body: { encrypted_value: "[sealed]" },
    });
  });

  test("repository, organization, Dependabot, Codespaces and legacy paths match their retries", async () => {
    const { put } = harness();
    for (const [path, extra] of [
      ["/repos/acme/ops/actions/secrets/TOKEN", {}],
      ["/repos/acme/ops/dependabot/secrets/TOKEN", {}],
      ["/repositories/11/environments/staging/secrets/TOKEN", {}],
      [
        "/orgs/acme/actions/secrets/TOKEN",
        { visibility: "selected", selected_repository_ids: [11] },
      ],
      ["/user/codespaces/secrets/TOKEN", { selected_repository_ids: [11] }],
    ] as const) {
      const first = await put(path, sealed(extra));
      const retry = await put(path, sealed(extra, "other-key"));
      expect(retry.digest).toBe(first.digest);
      expect(retry.reviewArguments).toEqual(first.reviewArguments);
    }
  });

  test("a different repository, environment or secret name never matches", async () => {
    const { put } = harness();
    const approved = (await put(ENV_SECRET, sealed())).digest;
    for (const path of [
      "/repos/acme/widgets/environments/staging/secrets/SLACK_WEBHOOK_URL",
      "/repos/acme/ops/environments/production/secrets/SLACK_WEBHOOK_URL",
      "/repos/acme/ops/environments/staging/secrets/OTHER_SECRET",
      "/repos/acme/ops/actions/secrets/SLACK_WEBHOOK_URL",
      `${ENV_SECRET}?unexpected=1`,
    ]) {
      expect((await put(path, sealed())).digest).not.toBe(approved);
    }
    const actions = (await put("/repos/acme/ops/actions/secrets/TOKEN", sealed())).digest;
    const dependabot = (await put("/repos/acme/ops/dependabot/secrets/TOKEN", sealed())).digest;
    expect(dependabot).not.toBe(actions);
    const mine = (await put("/user/codespaces/secrets/TOKEN", sealed())).digest;
    const org = (await put("/orgs/acme/codespaces/secrets/TOKEN", sealed())).digest;
    expect(org).not.toBe(mine);
  });

  test("who can read an organization secret stays part of the approval", async () => {
    const { put } = harness();
    const path = "/orgs/acme/actions/secrets/TOKEN";
    const selectedOnly = await put(
      path,
      sealed({ visibility: "selected", selected_repository_ids: [11] }),
    );
    const wider = await put(path, sealed({ visibility: "all" }));
    const moreRepos = await put(
      path,
      sealed({ visibility: "selected", selected_repository_ids: [11, 12] }),
    );
    expect(wider.digest).not.toBe(selectedOnly.digest);
    expect(moreRepos.digest).not.toBe(selectedOnly.digest);
  });

  test("other writes stay bound to their exact body", async () => {
    const { put } = harness();
    const variable = "/repos/acme/ops/environments/staging/variables/REGION";
    const a = await put(variable, { name: "REGION", value: "eu" });
    const b = await put(variable, { name: "REGION", value: "us" });
    expect(b.digest).not.toBe(a.digest);
    // A body under a secrets path that is not a sealed secret is not relaxed.
    const plain = "/repos/acme/ops/actions/secrets/TOKEN";
    const c = await put(plain, { value: "one" });
    const d = await put(plain, { value: "two" });
    expect(d.digest).not.toBe(c.digest);
    // A file that happens to live under a `secrets` directory is not a secret.
    const file = "/repos/acme/ops/contents/secrets/notes.txt";
    const e = await put(file, { message: "m", content: "YQ==", encrypted_value: "x" });
    const f = await put(file, { message: "m", content: "YQ==", encrypted_value: "y" });
    expect(f.digest).not.toBe(e.digest);
  });
});
