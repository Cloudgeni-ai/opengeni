import type { Settings } from "@opengeni/config";
import type { Database } from "@opengeni/db";
import { ensureManagedAccessForUser } from "@opengeni/db";
import { betterAuth, type Auth } from "better-auth";
import { createEmailVerificationToken } from "better-auth/api";
import { Pool } from "pg";
import { Resend } from "resend";

export type ManagedAuth = Auth<any>;

export function createManagedAuth(settings: Settings, db: Database): ManagedAuth | null {
  if (settings.productAccessMode !== "managed") {
    return null;
  }
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
      ...(settings.betterAuthCookieDomain ? {
        crossSubDomainCookies: {
          enabled: true,
          domain: settings.betterAuthCookieDomain,
        },
      } : {}),
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

export async function managedSessionAccessContext(auth: ManagedAuth, db: Database, headers: Headers) {
  const session = await auth.api.getSession({ headers });
  if (!session?.user) {
    return null;
  }
  return await ensureManagedAccessForUser(db, {
    userId: session.user.id,
    email: session.user.email,
    name: session.user.name,
  });
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

async function sendEmail(settings: Settings, input: {
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<void> {
  if (!settings.resendApiKey) {
    if (settings.environment === "local" || settings.environment === "test") {
      console.warn(`[opengeni] Skipping email to ${input.to}: OPENGENI_RESEND_API_KEY is not configured`);
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
    throw new Error("OPENGENI_BETTER_AUTH_SECRET is required to send managed auth verification email");
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
  return raw.split(",").map((value) => value.trim()).filter(Boolean);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
