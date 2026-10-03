import { z } from "zod";
import {
  MANAGED_AUTH_SESSION_SET_API_CONTRACT_REVISION,
  ManagedAuthSessionSetProjection,
  ManagedAuthLoginTransaction,
  CompleteManagedAuthLoginTransactionResponse,
} from "../../../packages/contracts/src/managed-auth-session-sets";
import type { Identity } from "./config";
import { STAGING_ORIGIN } from "./config";
import { HumanHttp, ProbeError } from "./http";

export type FreshIdentity = Extract<Identity, { kind: "fresh" }>;
export type VerificationReader = (identity: FreshIdentity, signal: AbortSignal) => Promise<string>;
export const PublicConfig = z.object({
  deploymentRevision: z.string(),
  apiContractRevision: z.string(),
  managedAuthSessionSetMode: z.enum(["legacy", "dual", "broker"]),
  defaultSandboxBackend: z.string(),
  auth: z.object({
    mode: z.literal("managedSession"),
    emailVerificationRequired: z.literal(true),
    newSignupsEnabled: z.boolean(),
  }),
});
export type PublicConfig = z.infer<typeof PublicConfig>;
const User = z.object({
  user: z.object({
    id: z.string().min(1),
    email: z.string().email(),
    emailVerified: z.literal(true),
    createdAt: z.string().datetime(),
  }),
});
const Signup = z.object({
  user: z.object({
    id: z.string().min(1),
    email: z.string().email(),
    emailVerified: z.literal(false),
    createdAt: z.string().datetime(),
  }),
});
const Setup = z.object({
  organizationId: z.string().uuid(),
  personalWorkspaceId: z.string().uuid(),
});
const Memberships = z.object({
  memberships: z.array(
    z.object({
      organizationId: z.string().uuid(),
      personalWorkspaceId: z.string().uuid(),
      status: z.literal("active"),
    }),
  ),
});

export function verificationPath(link: string): string {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new ProbeError("invalid_verification_link");
  }
  if (
    url.origin !== STAGING_ORIGIN ||
    url.pathname !== "/v1/auth/verify-email" ||
    url.username ||
    url.password ||
    url.hash ||
    !url.searchParams.get("token")
  )
    throw new ProbeError("non_staging_verification_link");
  const callback = url.searchParams.get("callbackURL");
  if (callback && new URL(callback, STAGING_ORIGIN).origin !== STAGING_ORIGIN)
    throw new ProbeError("non_staging_verification_callback");
  return `${url.pathname}${url.search}`;
}
export async function freshSignup(input: {
  identity: FreshIdentity;
  http: HumanHttp;
  config: PublicConfig;
  password: string;
  verificationReader: VerificationReader;
  signal: AbortSignal;
  stage: (name: string) => void;
  now: () => number;
}): Promise<{ workspaceId: string; organizationId: string }> {
  const { identity, http, config, signal, stage } = input;
  if (!config.auth.newSignupsEnabled) throw new ProbeError("new_signups_paused");
  // In dual/broker mode, initialize a separate browser session-set authority.
  if (config.managedAuthSessionSetMode !== "legacy") {
    stage("auth_session_set");
    await http.json("/v1/auth/session-set", "GET", signal);
  }
  stage("signup");
  const signupStartedAt = input.now();
  const signup = Signup.parse(
    await http.json("/v1/auth/sign-up/email", "POST", signal, {
      name: identity.label,
      email: identity.email,
      password: input.password,
      callbackURL: STAGING_ORIGIN,
    }),
  );
  if (
    signup.user.email.toLowerCase() !== identity.email.toLowerCase() ||
    Date.parse(signup.user.createdAt) < signupStartedAt - 1_000
  )
    throw new ProbeError("signup_did_not_create_a_fresh_identity");
  stage("email_verification_wait");
  const link = await input.verificationReader(identity, signal);
  stage("email_verification");
  const verified = await http.request(verificationPath(link), "GET", signal, undefined, {}, true);
  void verified.body?.cancel().catch(() => {});
  stage("signin");
  if (config.managedAuthSessionSetMode === "legacy") {
    await http.json("/v1/auth/sign-in/email", "POST", signal, {
      email: identity.email,
      password: input.password,
      rememberMe: true,
    });
  } else {
    let projection = ManagedAuthSessionSetProjection.parse(
      await http.json("/v1/auth/session-set", "GET", signal),
    );
    const headers = () => ({
      "x-opengeni-api-contract": MANAGED_AUTH_SESSION_SET_API_CONTRACT_REVISION,
      "x-opengeni-session-csrf": projection.csrfToken,
      "x-opengeni-actor-epoch": projection.actorEpoch,
    });
    const transaction = ManagedAuthLoginTransaction.parse(
      await http.json(
        "/v1/auth/session-set/transactions",
        "POST",
        signal,
        {
          operationId: crypto.randomUUID(),
          expectedGeneration: projection.generation,
          kind: "add",
        },
        headers(),
      ),
    );
    const completed = CompleteManagedAuthLoginTransactionResponse.parse(
      await http.json(
        "/v1/auth/session-set/transactions/email-password",
        "POST",
        signal,
        {
          operationId: crypto.randomUUID(),
          expectedGeneration: projection.generation,
          transactionId: transaction.id,
          email: identity.email,
          password: input.password,
        },
        headers(),
      ),
    );
    projection = completed.projection;
    const slot = projection.slots.find(
      (s) =>
        s.state === "active" &&
        s.verifiedClaim.value.toLowerCase() === identity.email.toLowerCase(),
    );
    if (!slot) throw new ProbeError("fresh_verified_slot_missing");
    projection = ManagedAuthSessionSetProjection.parse(
      await http.json(
        "/v1/auth/session-set/select",
        "POST",
        signal,
        {
          operationId: crypto.randomUUID(),
          expectedGeneration: projection.generation,
          slotId: slot.id,
        },
        headers(),
      ),
    );
    if (projection.selectedSlotId !== slot.id) throw new ProbeError("fresh_actor_selection_failed");
    http.actorEpoch = projection.actorEpoch;
  }
  stage("verify_authenticated_human");
  const user = User.parse(await http.json("/v1/auth/get-session", "GET", signal));
  if (
    user.user.id !== signup.user.id ||
    user.user.email.toLowerCase() !== identity.email.toLowerCase() ||
    user.user.createdAt !== signup.user.createdAt
  )
    throw new ProbeError("wrong_authenticated_human");
  stage("onboarding_status");
  const status = z
    .object({ state: z.literal("required") })
    .parse(await http.json("/v1/auth/organization-onboarding", "GET", signal));
  if (status.state !== "required") throw new ProbeError("identity_not_genuinely_fresh");
  const before = Memberships.parse(await http.json("/v1/organization-memberships", "GET", signal));
  if (before.memberships.length !== 0) throw new ProbeError("identity_already_onboarded");
  stage("organization_onboarding");
  const setup = Setup.parse(
    await http.json("/v1/auth/organization-onboarding", "POST", signal, {
      organizationName: identity.organizationName,
      useCase: "cloud",
      operationId: crypto.randomUUID(),
    }),
  );
  const after = Memberships.parse(await http.json("/v1/organization-memberships", "GET", signal));
  if (
    after.memberships.length !== 1 ||
    after.memberships[0]?.organizationId !== setup.organizationId ||
    after.memberships[0]?.personalWorkspaceId !== setup.personalWorkspaceId
  )
    throw new ProbeError("fresh_personal_workspace_mismatch");
  return { workspaceId: setup.personalWorkspaceId, organizationId: setup.organizationId };
}
