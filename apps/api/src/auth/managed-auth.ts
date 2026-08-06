import { servingDatabaseRole, servingDatabaseUrl, type Settings } from "@opengeni/config";
import { type ManagedAuth } from "@opengeni/core";
import type { Database } from "@opengeni/db";
import { ensureManagedAccessForUser } from "@opengeni/db";
import { betterAuth } from "better-auth";
import { createEmailVerificationToken } from "better-auth/api";
import { Pool } from "pg";
import { Resend } from "resend";

// `ManagedAuth` (the Better Auth `Auth<any>` alias) is owned by @opengeni/core
// (`managed-auth-type.ts`) — `dependencies.ts`/`access` reference it as a
// type-only slot. We re-export it from this construction site so existing
// importers (`app.ts`) keep the same import path.
export type { ManagedAuth };

export function createManagedAuth(settings: Settings, db: Database): ManagedAuth | null {
  if (settings.productAccessMode !== "managed") {
    return null;
  }
  const connectionString = servingDatabaseUrl(settings);
  const pool = new Pool({ connectionString });
  installManagedAuthConnectionGate(pool, settings);
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
      requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true,
      onExistingUserSignUp: async ({ user }) => {
        if (!user.emailVerified) {
          const url = await verificationUrl(settings, user.email);
          await sendEmail(settings, {
            to: user.email,
            subject: "Verify your OpenGeni email",
            text: `Verify your OpenGeni email: ${url}`,
            html: `<p>Verify your OpenGeni email:</p><p><a href="${escapeHtml(url)}">Verify email</a></p>`,
          });
        }
      },
      sendResetPassword: async ({ user, url }) => {
        await sendEmail(settings, {
          to: user.email,
          subject: "Reset your OpenGeni password",
          text: `Reset your OpenGeni password: ${url}`,
          html: `<p>Reset your OpenGeni password:</p><p><a href="${escapeHtml(url)}">Reset password</a></p>`,
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: async ({ user, url }) => {
        await sendEmail(settings, {
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
        });
      },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await ensureManagedAccessForUser(db, {
              userId: user.id,
              email: user.email,
              name: user.name,
            });
          },
        },
      },
    },
  }) as ManagedAuth;
}

/** Gate every Better Auth checkout before it can issue an authentication query. */
function installManagedAuthConnectionGate(pool: Pool, settings: Settings): void {
  const expectedRole = servingDatabaseRole(settings);
  const forbiddenRoles = [
    settings.organizationGovernanceEnabled
      ? settings.runtimeDatabaseRole
      : settings.organizationGovernanceDatabaseRole,
    "opengeni_governance_operator",
  ];
  const originalConnect = pool.connect.bind(pool);
  const gates = new WeakMap<object, Promise<void>>();
  const verify = async (client: {
    query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }>;
    release?: () => void;
  }) => {
    const identity = await client.query(
      `select current_user::text as current_user,
              session_user::text as session_user,
              r.rolcanlogin,
              r.rolsuper,
              r.rolbypassrls
         from pg_catalog.pg_roles r
        where r.rolname = current_user`,
    );
    const row = identity.rows[0];
    if (
      !row ||
      row.current_user !== expectedRole ||
      row.session_user !== expectedRole ||
      row.rolcanlogin !== true ||
      row.rolsuper === true ||
      row.rolbypassrls === true
    ) {
      throw new Error(`managed auth database connection authority mismatch for ${expectedRole}`);
    }
    const memberships = await client.query(
      `with recursive reachable(oid) as (
         select oid from pg_catalog.pg_roles where rolname = current_user
         union
         select membership.roleid
           from pg_catalog.pg_auth_members membership
           join reachable member on member.oid = membership.member
       )
       select role.rolname::text as rolname
         from pg_catalog.pg_roles role
        where role.oid in (select oid from reachable)
          and role.rolname = any($1::text[])`,
      [forbiddenRoles],
    );
    if (memberships.rows.length > 0) {
      throw new Error("managed auth database connection has forbidden role membership");
    }
  };
  pool.on("connect", (client) => {
    const gate = verify(client);
    gates.set(client, gate);
    void gate.catch(() => client.release());
  });
  (pool as Pool & { connect: typeof pool.connect }).connect = ((
    callback?: (...args: any[]) => void,
  ) => {
    const gated = originalConnect().then(async (client) => {
      await (gates.get(client) ?? verify(client));
      return client;
    });
    if (callback) {
      void gated.then(
        (client) => callback(null, client, client.release.bind(client)),
        (error) => callback(error),
      );
      return undefined;
    }
    return gated;
  }) as typeof pool.connect;
  (pool as Pool & { query: typeof pool.query }).query = ((...args: any[]) => {
    const callback = typeof args.at(-1) === "function" ? args.pop() : undefined;
    const query = (pool.connect as any)().then(async (client: any) => {
      try {
        return await client.query(...args);
      } finally {
        client.release();
      }
    });
    if (callback) {
      void query.then(
        (result: unknown) => callback(null, result),
        (error: unknown) => callback(error),
      );
      return undefined;
    }
    return query;
  }) as typeof pool.query;
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

async function sendEmail(
  settings: Settings,
  input: {
    to: string;
    subject: string;
    text: string;
    html: string;
  },
): Promise<void> {
  if (!settings.resendApiKey) {
    if (settings.environment === "local" || settings.environment === "test") {
      console.warn(
        `[opengeni] Skipping email to ${input.to}: OPENGENI_RESEND_API_KEY is not configured`,
      );
      return;
    }
    throw new Error("OPENGENI_RESEND_API_KEY is required to send managed auth email");
  }
  const resend = new Resend(settings.resendApiKey);
  const result = await resend.emails.send({
    from: settings.emailFrom,
    to: input.to,
    subject: input.subject,
    text: input.text,
    html: input.html,
  });
  if (result.error) {
    throw new Error(result.error.message);
  }
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
