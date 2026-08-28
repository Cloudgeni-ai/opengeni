import type { Settings } from "@opengeni/config";
import {
  type ManagedAuth,
  type ManagedEmailMessage,
  type ManagedEmailTransport,
} from "@opengeni/core";
import type { Database } from "@opengeni/db";
import { ensureManagedAccessForUser } from "@opengeni/db";
import {
  ensureCanonicalHumanIdentityForAuthUser,
  getCanonicalHumanIdentityProjection,
  getCanonicalHumanExactLoginBindingForAuthUser,
  synchronizeCanonicalHumanLoginBindings,
} from "@opengeni/db/canonical-human-identities";
import { betterAuth } from "better-auth";
import { createEmailVerificationToken } from "better-auth/api";
import { hashPassword } from "better-auth/crypto";
import { sql } from "drizzle-orm";
import { Pool } from "pg";

import { decideCanonicalHumanSessionAdmission } from "./canonical-human-session-admission";
import {
  currentManagedAuthProviderId,
  currentManagedAuthAttemptId,
  recordCurrentManagedAuthSession,
  shouldDiscardCurrentManagedAuthProviderSession,
} from "./managed-auth-attempt-context";

// `ManagedAuth` (the Better Auth `Auth<any>` alias) is owned by @opengeni/core
// (`managed-auth-type.ts`) — `dependencies.ts`/`access` reference it as a
// type-only slot. We re-export it from this construction site so existing
// importers (`app.ts`) keep the same import path.
export type { ManagedAuth };

export function managedAuthRequiresEmailVerification(
  settings: Pick<Settings, "environment">,
): boolean {
  return settings.environment !== "local";
}

export function managedAuthUserCreateOverride(
  settings: Pick<Settings, "environment">,
  user: { emailVerified: boolean } & Record<string, unknown>,
): { data: typeof user } | undefined {
  if (managedAuthRequiresEmailVerification(settings)) return undefined;
  return { data: { ...user, emailVerified: true } };
}

/** Keep Better Auth password policy and storage format behind this boundary. */
export async function hashManagedAuthPassword(password: string): Promise<string> {
  return await hashPassword(password);
}

export function createManagedAuth(
  settings: Settings,
  db: Database,
  managedEmailTransport: ManagedEmailTransport,
): ManagedAuth | null {
  if (settings.productAccessMode !== "managed") {
    return null;
  }
  const requireEmailVerification = managedAuthRequiresEmailVerification(settings);
  const pool = new Pool({ connectionString: settings.databaseUrl });
  return betterAuth({
    appName: "OpenGeni",
    baseURL: betterAuthBaseUrl(settings),
    basePath: "/v1/auth",
    secret: settings.betterAuthSecret,
    database: pool,
    trustedOrigins: betterAuthTrustedOrigins(settings),
    advanced: {
      useSecureCookies: settings.publicBaseUrl?.startsWith("https://") ?? false,
      ...(settings.betterAuthCookieDomain
        ? {
            crossSubDomainCookies: {
              enabled: true,
              domain: settings.betterAuthCookieDomain,
            },
          }
        : {}),
      database: {
        generateId: () => crypto.randomUUID(),
      },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      modelName: "auth_rate_limits",
      fields: {
        lastRequest: "last_request",
      },
    },
    user: {
      modelName: "auth_users",
      fields: {
        emailVerified: "email_verified",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    session: {
      modelName: "auth_sessions",
      fields: {
        userId: "user_id",
        expiresAt: "expires_at",
        ipAddress: "ip_address",
        userAgent: "user_agent",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
      additionalFields: {
        identityId: {
          type: "string",
          fieldName: "identity_id",
          input: false,
          returned: false,
        },
        identityRevision: {
          type: "number",
          fieldName: "identity_revision",
          input: false,
          returned: false,
          bigint: true,
        },
        authRevision: {
          type: "number",
          fieldName: "auth_revision",
          input: false,
          returned: false,
          bigint: true,
        },
        loginBindingId: {
          type: "string",
          fieldName: "login_binding_id",
          input: false,
          returned: false,
        },
        loginBindingRevision: {
          type: "number",
          fieldName: "login_binding_revision",
          input: false,
          returned: false,
          bigint: true,
        },
        managedAuthLoginTransactionId: {
          type: "string",
          fieldName: "managed_auth_login_transaction_id",
          input: false,
          returned: false,
        },
      },
    },
    account: {
      modelName: "auth_identities",
      fields: {
        userId: "user_id",
        accountId: "account_id",
        providerId: "provider_id",
        accessToken: "access_token",
        refreshToken: "refresh_token",
        idToken: "id_token",
        accessTokenExpiresAt: "access_token_expires_at",
        refreshTokenExpiresAt: "refresh_token_expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
      accountLinking: {
        enabled: false,
      },
      encryptOAuthTokens: true,
      storeStateStrategy: "database",
    },
    socialProviders: {
      ...(settings.managedAuthGoogleClientId && settings.managedAuthGoogleClientSecret
        ? {
            google: {
              clientId: settings.managedAuthGoogleClientId,
              clientSecret: settings.managedAuthGoogleClientSecret,
              prompt: "select_account" as const,
            },
          }
        : {}),
      ...(settings.managedAuthGithubClientId && settings.managedAuthGithubClientSecret
        ? {
            github: {
              clientId: settings.managedAuthGithubClientId,
              clientSecret: settings.managedAuthGithubClientSecret,
            },
          }
        : {}),
    },
    verification: {
      modelName: "auth_verifications",
      fields: {
        expiresAt: "expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
      storeIdentifier: "hashed",
    },
    emailAndPassword: {
      enabled: true,
      // Local managed mode exists so the complete human/org tenancy flow can
      // be exercised without first configuring a transactional-email vendor.
      // Every non-local deployment retains the verified-email boundary.
      requireEmailVerification,
      revokeSessionsOnPasswordReset: true,
      onExistingUserSignUp: async ({ user }) => {
        if (requireEmailVerification && !user.emailVerified) {
          const url = await verificationUrl(settings, user.email);
          await sendManagedAuthEmail(managedEmailTransport, {
            kind: "email_verification",
            to: user.email,
            subject: "Verify your OpenGeni email",
            text: `Verify your OpenGeni email: ${url}`,
            html: `<p>Verify your OpenGeni email:</p><p><a href="${escapeHtml(url)}">Verify email</a></p>`,
          });
        }
      },
      sendResetPassword: async ({ user, url }) => {
        await sendManagedAuthEmail(managedEmailTransport, {
          kind: "password_reset",
          to: user.email,
          subject: "Reset your OpenGeni password",
          text: `Reset your OpenGeni password: ${url}`,
          html: `<p>Reset your OpenGeni password:</p><p><a href="${escapeHtml(url)}">Reset password</a></p>`,
        });
      },
    },
    emailVerification: {
      sendOnSignUp: requireEmailVerification,
      sendVerificationEmail: async ({ user, url }) => {
        await sendManagedAuthEmail(managedEmailTransport, {
          kind: "email_verification",
          to: user.email,
          subject: "Verify your OpenGeni email",
          text: `Verify your OpenGeni email: ${url}`,
          html: `<p>Verify your OpenGeni email:</p><p><a href="${escapeHtml(url)}">Verify email</a></p>`,
        });
      },
      afterEmailVerification: async (user) => {
        await ensureManagedAccessForUser(db, {
          userId: user.id,
          email: user.email,
          name: user.name,
          emailVerified: true,
          provisionFallbackOrganization: false,
        });
      },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const providerId = currentManagedAuthProviderId();
            await ensureCanonicalHumanIdentityForAuthUser(db, session.userId);
            const preflightProjection = await getCanonicalHumanIdentityProjection(
              db,
              session.userId,
            );
            const preflight = decideCanonicalHumanSessionAdmission({
              intent: "binding_synchronization",
              identity: preflightProjection.activeIdentity,
              binding: null,
            });
            if (!preflight.allowed) {
              const exactRecoveryBinding = await getCanonicalHumanExactLoginBindingForAuthUser(db, {
                authUserId: session.userId,
                providerId,
              });
              const recoveryBinding = preflightProjection.loginBindings.find(
                (binding) =>
                  binding.id === exactRecoveryBinding.id && binding.status === "recovery_pending",
              );
              const recoveryAdmission = decideCanonicalHumanSessionAdmission({
                intent: "recovery_completion",
                identity: preflightProjection.activeIdentity,
                binding: recoveryBinding
                  ? {
                      id: recoveryBinding.id,
                      identityId: preflightProjection.activeIdentity.id,
                      status: recoveryBinding.status,
                    }
                  : null,
              });
              if (!recoveryAdmission.allowed) {
                return false;
              }
              return {
                data: {
                  ...session,
                  ...(shouldDiscardCurrentManagedAuthProviderSession()
                    ? { expiresAt: new Date(0) }
                    : {}),
                  identityId: preflightProjection.activeIdentity.id,
                  identityRevision: preflightProjection.activeIdentity.identityRevision,
                  authRevision: preflightProjection.activeIdentity.authRevision,
                  loginBindingId: recoveryBinding!.id,
                  loginBindingRevision: recoveryBinding!.revision,
                  managedAuthLoginTransactionId: currentManagedAuthAttemptId(),
                },
              };
            }

            await synchronizeCanonicalHumanLoginBindings(db, session.userId);
            const projection = await getCanonicalHumanIdentityProjection(db, session.userId);
            const exactBinding = await getCanonicalHumanExactLoginBindingForAuthUser(db, {
              authUserId: session.userId,
              providerId,
            });
            const activeBinding = projection.loginBindings.find(
              (binding) => binding.id === exactBinding.id,
            );
            const admission = decideCanonicalHumanSessionAdmission({
              intent: "ordinary_session",
              identity: projection.activeIdentity,
              binding: activeBinding
                ? {
                    id: activeBinding.id,
                    identityId: projection.activeIdentity.id,
                    status: activeBinding.status,
                  }
                : null,
            });
            if (!admission.allowed) {
              return false;
            }

            return {
              data: {
                ...session,
                ...(shouldDiscardCurrentManagedAuthProviderSession()
                  ? { expiresAt: new Date(0) }
                  : {}),
                identityId: projection.activeIdentity.id,
                identityRevision: projection.activeIdentity.identityRevision,
                authRevision: projection.activeIdentity.authRevision,
                loginBindingId: exactBinding.id,
                loginBindingRevision: exactBinding.revision,
                managedAuthLoginTransactionId: currentManagedAuthAttemptId(),
              },
            };
          },
          after: async (session) => {
            recordCurrentManagedAuthSession(session.id);
            if (!shouldDiscardCurrentManagedAuthProviderSession()) return;
            await db.execute(sql`delete from auth_sessions where id = ${session.id}`);
          },
        },
      },
      user: {
        create: {
          before: async (user) => managedAuthUserCreateOverride(settings, user),
          after: async (user) => {
            if (!user.emailVerified) return;
            await ensureManagedAccessForUser(db, {
              userId: user.id,
              email: user.email,
              name: user.name,
              emailVerified: true,
              provisionFallbackOrganization: false,
            });
          },
        },
      },
    },
  }) as ManagedAuth;
}

export type ManagedAuthOAuthAttempt = {
  transactionId: string;
  provider: "google" | "github";
  authorityHash: string;
  transactionSecretHash: string;
  expectedGeneration: string;
  expectedActorEpoch: string;
};

/**
 * Resolve OpenGeni's server-only login transaction proof from Better Auth's
 * database-backed OAuth state before the provider callback consumes it.
 */
export async function resolveManagedAuthOAuthAttempt(
  auth: ManagedAuth,
  request: Request,
  provider: "google" | "github",
): Promise<ManagedAuthOAuthAttempt | null> {
  const state = new URL(request.url).searchParams.get("state");
  if (!state) return null;
  const verification = await (await auth.$context).internalAdapter.findVerificationValue(state);
  if (!verification?.value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(verification.value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const stateData = parsed as Record<string, unknown>;
  const proof = stateData.opengeniManagedAuth;
  if (!proof || typeof proof !== "object") return null;
  const value = proof as Record<string, unknown>;
  if (
    value.version !== 1 ||
    value.provider !== provider ||
    typeof value.transactionId !== "string" ||
    typeof value.authorityHash !== "string" ||
    typeof value.transactionSecretHash !== "string" ||
    typeof value.expectedGeneration !== "string" ||
    typeof value.expectedActorEpoch !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value.transactionId,
    ) ||
    !/^[0-9a-f]{64}$/u.test(value.authorityHash) ||
    !/^[0-9a-f]{64}$/u.test(value.transactionSecretHash) ||
    !/^[1-9][0-9]*$/u.test(value.expectedGeneration) ||
    !/^[1-9][0-9]*$/u.test(value.expectedActorEpoch)
  ) {
    return null;
  }
  const callbackURL = typeof stateData.callbackURL === "string" ? stateData.callbackURL : null;
  if (
    !callbackURL ||
    !managedAuthOAuthReturnMatches(callbackURL, value.transactionId, "complete")
  ) {
    return null;
  }
  return {
    transactionId: value.transactionId,
    provider,
    authorityHash: value.authorityHash,
    transactionSecretHash: value.transactionSecretHash,
    expectedGeneration: value.expectedGeneration,
    expectedActorEpoch: value.expectedActorEpoch,
  };
}

export async function isolatedManagedAuthOAuthCallbackRequest(
  auth: ManagedAuth,
  request: Request,
): Promise<{ request: Request; stateCookieName: string }> {
  const context = await auth.$context;
  const stateCookieName = context.createAuthCookie("state").name;
  const headers = new Headers(request.headers);
  const stateCookie = cookiePair(headers.get("cookie"), stateCookieName);
  if (stateCookie) headers.set("cookie", stateCookie);
  else headers.delete("cookie");
  headers.delete("authorization");
  headers.delete("x-forwarded-user");
  return { request: new Request(request, { headers }), stateCookieName };
}

function managedAuthOAuthReturnMatches(
  raw: string,
  transactionId: string,
  outcome: "complete" | "error",
): boolean {
  try {
    const url = new URL(raw);
    return (
      url.pathname === "/account-auth" &&
      url.searchParams.size === 2 &&
      url.searchParams.get("transaction") === transactionId &&
      url.searchParams.get("social") === outcome &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function cookiePair(header: string | null, name: string): string | null {
  for (const part of header?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return `${name}=${part.slice(separator + 1).trim()}`;
  }
  return null;
}

function betterAuthBaseUrl(settings: Settings) {
  const allowedHosts = splitCsv(settings.betterAuthAllowedHosts);
  if (allowedHosts.length === 0) {
    return settings.publicBaseUrl;
  }
  return {
    allowedHosts,
    fallback: settings.publicBaseUrl,
    protocol: "auto" as const,
  };
}

function betterAuthTrustedOrigins(settings: Settings): string[] {
  const origins = new Set<string>();
  if (settings.publicBaseUrl) {
    origins.add(new URL(settings.publicBaseUrl).origin);
  }
  for (const origin of splitCsv(settings.betterAuthTrustedOrigins)) {
    origins.add(origin);
  }
  return [...origins];
}

export async function sendManagedAuthEmail(
  transport: ManagedEmailTransport,
  input: Omit<ManagedEmailMessage, "from">,
): Promise<void> {
  const result = await transport.send({ ...input, from: transport.sender });
  if (result.status !== "sent") throw new Error(`managed email ${result.status}`);
}

async function verificationUrl(settings: Settings, email: string): Promise<string> {
  if (!settings.betterAuthSecret) {
    throw new Error(
      "OPENGENI_BETTER_AUTH_SECRET is required to send managed auth verification email",
    );
  }
  if (!settings.publicBaseUrl) {
    throw new Error("OPENGENI_PUBLIC_BASE_URL is required to send managed auth verification email");
  }
  const token = await createEmailVerificationToken(settings.betterAuthSecret, email);
  const url = new URL("/v1/auth/verify-email", settings.publicBaseUrl);
  url.searchParams.set("token", token);
  url.searchParams.set("callbackURL", "/");
  return url.toString();
}

function splitCsv(raw: string): string[] {
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
