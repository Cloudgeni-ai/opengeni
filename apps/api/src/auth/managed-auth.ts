import { requireSignupChallenge } from "./signup-challenge";
import { canonicalPublicOrigin, managedUserEmailAllowed, type Settings } from "@opengeni/config";
import {
  MANAGED_AUTH_NEW_SIGNUPS_PAUSED_CODE,
  MANAGED_AUTH_SIGNUP_EMAIL_NOT_ALLOWED_CODE,
} from "@opengeni/contracts";
import {
  configureManagedUserAdmission,
  recordManagedAuthLoggedFailure,
  type ManagedAuth,
  type ManagedEmailMessage,
  type ManagedEmailTransport,
} from "@opengeni/core";
import type {
  Database,
  DatabaseCredentialEventListener,
  DatabasePasswordFiles,
  RotatingDatabasePassword,
} from "@opengeni/db";
import {
  databasePasswordFileOptions,
  ensureManagedAccessForUser,
  logDatabaseCredentialEvent,
  observeDatabaseCredentialEvents,
  rotatingDatabasePasswordFor,
  tagDatabaseLoginAttempt,
  withDatabaseAuthenticationRetry,
} from "@opengeni/db";
import {
  ensureCanonicalHumanIdentityForAuthUser,
  getCanonicalHumanIdentityProjection,
  getCanonicalHumanExactLoginBindingForAuthUser,
  synchronizeCanonicalHumanLoginBindings,
} from "@opengeni/db/canonical-human-identities";
import type { Observability } from "@opengeni/observability";
import { betterAuth } from "better-auth";
import { APIError, createEmailVerificationToken } from "better-auth/api";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { sql } from "drizzle-orm";
import { PostgresDialect } from "kysely";
import { Client, Pool, type ClientConfig, type PoolClient, type PoolConfig } from "pg";
import { parse as parseConnectionString } from "pg-connection-string";

import { TRUSTED_CLIENT_ADDRESS_HEADER } from "../http/request-source";
import { decideCanonicalHumanSessionAdmission } from "./canonical-human-session-admission";
import {
  createManagedAuthEmailThrottleHook,
  MANAGED_AUTH_BETTER_AUTH_RATE_LIMIT_RULES,
} from "./managed-auth-rate-limits";
import { deliverManagedSignInNotification } from "./managed-sign-in-notifications";
import {
  createManagedAuthNewSignupsGate,
  type ManagedAuthNewSignupsGate,
} from "./new-signups-gate";
import { createSignupFunnelMetrics } from "./signup-funnel-metrics";
import {
  currentManagedAuthProviderId,
  currentManagedAuthAttemptId,
  recordCurrentManagedAuthSession,
  shouldDiscardCurrentManagedAuthProviderSession,
  currentManagedSignInConnectIntent,
} from "./managed-auth-attempt-context";

// Only used when no Better Auth secret is configured (local development);
// the email throttle key is a content-free digest either way.
const MANAGED_AUTH_EMAIL_THROTTLE_FALLBACK_KEY = "opengeni:managed-auth:email-throttle:local";

// `ManagedAuth` (the Better Auth `Auth<any>` alias) is owned by @opengeni/core
// (`managed-auth-type.ts`) — `dependencies.ts`/`access` reference it as a
// type-only slot. We re-export it from this construction site so existing
// importers (`app.ts`) keep the same import path.
export type { ManagedAuth };

export function managedAuthRequiresEmailVerification(
  settings: Pick<Settings, "environment" | "managedAuthRequireEmailVerification">,
): boolean {
  return settings.managedAuthRequireEmailVerification ?? settings.environment !== "local";
}

export function managedAuthUserCreateOverride(
  settings: Pick<Settings, "environment" | "managedAuthRequireEmailVerification">,
  user: { emailVerified: boolean } & Record<string, unknown>,
): { data: typeof user } | undefined {
  if (managedAuthRequiresEmailVerification(settings)) return undefined;
  return { data: { ...user, emailVerified: true } };
}

export const MANAGED_AUTH_NEW_SIGNUPS_PAUSED_MESSAGE =
  "We're at capacity for new accounts right now. Please try again later.";

/**
 * Typed refusal for a new account while the deployment has paused sign-ups.
 * Existing accounts are unaffected; the body mirrors Better Auth's
 * `{ code, message }` error shape so browser and SDK callers parse it alike.
 */
export function managedAuthNewSignupsPausedResponse(): Response {
  return Response.json(
    {
      code: MANAGED_AUTH_NEW_SIGNUPS_PAUSED_CODE,
      message: MANAGED_AUTH_NEW_SIGNUPS_PAUSED_MESSAGE,
    },
    { status: 403, headers: { "cache-control": "no-store" } },
  );
}

/**
 * Thrown from the user-create hook while the runtime switch has paused new
 * sign-ups. Better Auth returns it as `403 { code: "NEW_SIGNUPS_PAUSED" }` on
 * email sign-up, and its OAuth callback turns the message into the
 * `error=signup_disabled` redirect it also uses for a static provider refusal.
 */
export class ManagedAuthNewSignupsPausedError extends APIError {
  constructor() {
    super("FORBIDDEN", { code: MANAGED_AUTH_NEW_SIGNUPS_PAUSED_CODE, message: "signup disabled" });
  }
}

/**
 * Thrown from the user-create hook when a deployment that restricts accounts to
 * `allowedUserEmails` is asked to create an account for an address that isn't on
 * the list. Better Auth returns it as `403 { code: "SIGNUP_EMAIL_NOT_ALLOWED" }` on
 * email and passkey sign-up, and its OAuth callback turns the message into
 * `error=signup_email_not_allowed`, so the sign-in page can say to ask whoever
 * runs the service to allow the address instead of offering a retry that can
 * never succeed. Allowed and refused addresses already got different
 * responses, so this reveals nothing new.
 */
export class ManagedAuthSignupEmailNotAllowedError extends APIError {
  constructor() {
    super("FORBIDDEN", {
      code: MANAGED_AUTH_SIGNUP_EMAIL_NOT_ALLOWED_CODE,
      message: "signup email not allowed",
    });
  }
}

/** True when the user-create hook refuses only because the address isn't on the allowed list. */
export function managedAuthSignupEmailNotAllowed(
  settings: Pick<Settings, "allowedUserEmails"> &
    Partial<Pick<Settings, "managedAuthNewSignupsEnabled">>,
  email: unknown,
): boolean {
  return (
    settings.managedAuthNewSignupsEnabled !== false &&
    !managedUserEmailAllowed(settings.allowedUserEmails, email)
  );
}

/**
 * A user-create refusal raised during an OAuth callback becomes the callback's
 * `error=` redirect value. Better Auth 1.7 redirects with the error's code;
 * the sign-in page and clients read the documented values (`signup_disabled`,
 * `signup_email_not_allowed`, `signup_challenge_required`), which are each
 * refusal's message with spaces as underscores, as Better Auth 1.6 built them.
 * Refusals on every other path keep their typed JSON code.
 */
export function managedAuthOAuthCallbackRefusal(error: unknown, path: string | undefined): unknown {
  if (!(error instanceof APIError) || !path?.startsWith("/callback/")) return error;
  const message = error.body?.message ?? error.message;
  if (!message) return error;
  return new APIError(error.status, { code: message.split(" ").join("_"), message });
}

export function managedAuthUserCreateAdmission(
  settings: Pick<Settings, "environment" | "allowedUserEmails"> &
    Partial<Pick<Settings, "managedAuthNewSignupsEnabled" | "managedAuthRequireEmailVerification">>,
  user: { emailVerified: boolean } & Record<string, unknown>,
  providerId: string,
): { data: typeof user } | false | undefined {
  // Backstop for every Better Auth user-create path. Invited-user account
  // setup does not create users through Better Auth, so it is unaffected.
  if (settings.managedAuthNewSignupsEnabled === false) return false;
  if (!managedUserEmailAllowed(settings.allowedUserEmails, user.email)) return false;
  // `.invalid` addresses (RFC 2606) reach no one. Only passkey sign-up stores
  // one, as the placeholder of an account without an email address; an
  // account created any other way with such an address would pass for one.
  if (
    providerId !== "passkey" &&
    typeof user.email === "string" &&
    user.email.trim().toLowerCase().endsWith(".invalid")
  ) {
    return false;
  }
  if (
    (settings.environment !== "local" || managedAuthRequiresEmailVerification(settings)) &&
    providerId !== "credential" &&
    !user.emailVerified
  ) {
    return false;
  }
  return managedAuthUserCreateOverride(settings, user);
}

/**
 * Per-provider Better Auth options while sign-ups are paused. A social sign-in
 * for an existing human still signs in (and may link a verified provider);
 * an unknown human is redirected back with `error=signup_disabled`.
 * `disableSignUp` is the hard switch: `disableImplicitSignUp` alone can be
 * overridden by a client-supplied `requestSignUp`.
 */
export function managedAuthSocialSignupOptions(
  settings: Pick<Settings, "managedAuthNewSignupsEnabled">,
): { disableImplicitSignUp?: true; disableSignUp?: true } {
  return settings.managedAuthNewSignupsEnabled
    ? {}
    : { disableImplicitSignUp: true, disableSignUp: true };
}

/** Keep Better Auth password policy and storage format behind this boundary. */
export async function hashManagedAuthPassword(password: string): Promise<string> {
  return await hashPassword(password);
}

export async function verifyManagedAuthPassword(password: string, hash: string): Promise<boolean> {
  return await verifyPassword({ password, hash });
}

type ManagedAuthPoolObservability = Pick<Observability, "warn" | "incrementCounter">;

/**
 * Better Auth's default console output, plus handing logged failures to the
 * session-lookup boundary so a lost database connection behind its generic
 * INTERNAL_SERVER_ERROR stays recognizable (see `withManagedAuthSessionLookup`).
 */
function logBetterAuthMessage(
  level: "debug" | "info" | "warn" | "error",
  message: string,
  ...args: unknown[]
): void {
  if (level === "error") recordManagedAuthLoggedFailure(args);
  const line = `${new Date().toISOString()} ${level.toUpperCase()} [Better Auth]: ${message}`;
  if (level === "error") console.error(line, ...args);
  else if (level === "warn") console.warn(line, ...args);
  else console.log(line, ...args);
}

/**
 * Bounded pool settings for Better Auth's dedicated `pg` pool. A connection
 * attempt fails after 10 s instead of queueing requests indefinitely while the
 * database is unreachable, and connections close when idle and recycle within
 * 30 minutes so a pooler- or failover-replaced backend is not held forever.
 * This pool runs only Better Auth's few unnamed statements, so its backends stay
 * small; the application pools' OPENGENI_DATABASE_POOL_* settings do not apply.
 */
export const MANAGED_AUTH_DATABASE_POOL_OPTIONS = {
  max: 10,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
  maxLifetimeSeconds: 1_800,
  keepAlive: true,
} as const satisfies PoolConfig;

/**
 * Better Auth's `pg` pool. When the server closes a connection (a restart,
 * failover, or maintenance window) `pg` emits `error`: on the pool for an idle
 * client, and on the client itself for one checked out by Better Auth's query
 * layer. Without listeners either becomes an uncaught exception and the API's
 * fatal process boundary exits. Both listeners record one content-free signal
 * and keep serving. The pool has already discarded a failed idle client and
 * opens a fresh connection for the next checkout; a checked-out client's
 * in-flight query already rejects to its caller, and the pool discards the
 * dead client on release. An idle client's error also reaches its own
 * listener, so that listener records only while the client is checked out,
 * and at most once per checkout.
 */
export function createManagedAuthDatabasePool(
  databaseUrl: string,
  observability?: ManagedAuthPoolObservability,
  passwordFiles?: DatabasePasswordFiles,
  onCredentialEvent: DatabaseCredentialEventListener = observability
    ? observeDatabaseCredentialEvents("managed-auth", observability)
    : logDatabaseCredentialEvent("managed-auth"),
): Pool {
  const credential = rotatingDatabasePasswordFor(databaseUrl, passwordFiles, onCredentialEvent);
  const pool = new Pool(
    credential
      ? {
          ...MANAGED_AUTH_DATABASE_POOL_OPTIONS,
          // `pg` lets a connectionString's password override a password
          // function, so pass the parsed fields instead, merged the way `pg`
          // merges them, with the file-backed password read on every new
          // connection.
          ...(parseConnectionString(databaseUrl) as unknown as PoolConfig),
          password: () => credential.password(),
          Client: rotatingPasswordClient(credential) as unknown as PoolConfig["Client"],
        }
      : { connectionString: databaseUrl, ...MANAGED_AUTH_DATABASE_POOL_OPTIONS },
  );
  if (credential) retryConnectAfterAuthenticationFailure(pool, credential);
  const checkedOut = new WeakSet<object>();
  pool.on("acquire", (client) => checkedOut.add(client));
  pool.on("release", (_error, client) => checkedOut.delete(client));
  pool.on("connect", (client) => {
    client.on("error", () => {
      // One lost connection can emit twice (the server's termination
      // message, then the socket end), so count it once.
      if (checkedOut.delete(client)) {
        recordManagedAuthPoolError(observability, "checked_out_connection_failed");
      }
    });
  });
  pool.on("error", () => recordManagedAuthPoolError(observability, "idle_connection_discarded"));
  return pool;
}

/**
 * A `pg` client class whose login records the file-backed password it used,
 * and whose connect error names that login, so a 28P01 is attributed to the
 * password this client actually tried rather than to whatever the pool
 * selects by the time the refusal arrives. Each `pg` client logs in once.
 * The login's identity is a private empty object, never the client: after a
 * refused login `pg` keeps the password it tried on the client.
 */
export function rotatingPasswordClient(credential: RotatingDatabasePassword): typeof Client {
  return class RotatingPasswordClient extends Client {
    readonly #login: object = {};

    constructor(config?: string | ClientConfig) {
      super(config);
      // `pg` asks `this.password()` once, while this client logs in.
      (this as unknown as { password: () => Promise<string> }).password = () =>
        credential.password(this.#login);
    }

    override connect(): Promise<Client>;
    override connect(callback: ((err: Error) => void) | ((err: null, c: Client) => void)): void;
    override connect(
      callback?: ((err: Error) => void) | ((err: null, c: Client) => void),
    ): Promise<Client> | void {
      if (!callback) {
        return super.connect().catch((error: unknown) => {
          tagDatabaseLoginAttempt(error, this.#login);
          throw error;
        });
      }
      super.connect(((error: Error | null, ...rest: unknown[]) => {
        if (error) tagDatabaseLoginAttempt(error, this.#login);
        (callback as (error: Error | null, ...rest: unknown[]) => void)(error, ...rest);
      }) as (err: Error) => void);
    }
  };
}

/**
 * Make the pool's checkouts (and so `pool.query`, which checks out through
 * `connect`) try again after a 28P01 on the password candidate the pool then
 * selects (see `withDatabaseAuthenticationRetry`). A 28P01 is raised only
 * while a new connection authenticates, before any statement runs, so
 * retrying a checkout cannot repeat work. A single password fails fast; the
 * last 28P01 surfaces unchanged.
 */
export function retryConnectAfterAuthenticationFailure(
  pool: Pool,
  credential: RotatingDatabasePassword,
): void {
  const connect = pool.connect.bind(pool) as () => Promise<PoolClient>;
  const connectWithRetry = () => withDatabaseAuthenticationRetry(credential, () => connect());
  type ConnectCallback = (
    error: Error | undefined,
    client: PoolClient | undefined,
    done: (release?: unknown) => void,
  ) => void;
  pool.connect = ((callback?: ConnectCallback) => {
    if (!callback) return connectWithRetry();
    // Call back outside the promise chain, as pg does (process.nextTick): an
    // exception thrown by the callback then surfaces as pg's would, instead of
    // becoming an unhandled rejection.
    connectWithRetry().then(
      (client) =>
        process.nextTick(() =>
          callback(undefined, client, (release) => client.release(release as Error)),
        ),
      (error: Error) => process.nextTick(() => callback(error, undefined, () => undefined)),
    );
    return undefined;
  }) as Pool["connect"];
}

export const MANAGED_AUTH_DATABASE_POOL_ERRORS_METRIC = {
  name: "opengeni_managed_auth_database_pool_errors_total",
  help: "Managed-auth database connections the server closed or lost, by pool state.",
} as const;

function recordManagedAuthPoolError(
  observability: ManagedAuthPoolObservability | undefined,
  outcome: "idle_connection_discarded" | "checked_out_connection_failed",
): void {
  try {
    observability?.incrementCounter({
      ...MANAGED_AUTH_DATABASE_POOL_ERRORS_METRIC,
      labels: { outcome },
    });
    observability?.warn("Managed auth database connection failed", {
      dependency: "managed_auth_database",
      outcome,
    });
  } catch {
    // An observer failure must not turn a recovered pool error into a crash.
  }
}

export function createManagedAuth(
  settings: Settings,
  db: Database,
  managedEmailTransport: ManagedEmailTransport,
  options: {
    observability?: ManagedAuthPoolObservability;
    newSignupsGate?: ManagedAuthNewSignupsGate;
  } = {},
): ManagedAuth | null {
  if (settings.productAccessMode !== "managed") {
    return null;
  }
  // Content-free sign-up funnel counters; recording never fails an auth flow.
  const funnel = options.observability
    ? createSignupFunnelMetrics(options.observability)
    : undefined;
  const requireEmailVerification = managedAuthRequiresEmailVerification(settings);
  // Same login as the application pool, so the same password files apply.
  const pool = createManagedAuthDatabasePool(
    settings.databaseUrl,
    options.observability,
    databasePasswordFileOptions(settings).passwordFiles,
  );
  // The deployment ceiling is static Better Auth configuration; the runtime
  // switch is checked per user create in the hook below.
  const newSignupsSocialProviderOptions = managedAuthSocialSignupOptions(settings);
  const newSignupsGate =
    options.newSignupsGate ??
    createManagedAuthNewSignupsGate({ db, settings, observability: options.observability });
  const auth = betterAuth({
    appName: "Opengeni",
    baseURL: betterAuthBaseUrl(settings),
    basePath: "/v1/auth",
    secret: settings.betterAuthSecret,
    database: {
      dialect: new PostgresDialect({ pool }),
      type: "postgres",
      // Given a bare pool, Better Auth 1.7 runs sign-up (user, account and
      // first session) and password changes inside one database transaction.
      // The session hook below creates the canonical identity through the
      // application database, a different connection, so it could neither see
      // the uncommitted user nor safely wait on that transaction's locks. Keep
      // Better Auth's writes non-transactional, as they were before 1.7.
      transaction: false,
    },
    trustedOrigins: betterAuthTrustedOrigins(settings),
    logger: { log: logBetterAuthMessage },
    hooks: {
      before: createManagedAuthEmailThrottleHook(
        db,
        settings.betterAuthSecret ?? MANAGED_AUTH_EMAIL_THROTTLE_FALLBACK_KEY,
        async ({ path, body }) => {
          // Email sign-up refusals are decided before the endpoint runs:
          // when email verification is required, Better Auth answers a 403
          // from the user-create hook with its generic "check your email"
          // success, which would hide these typed reasons. The user-create
          // hook below stays the backstop for every other path. A deployment
          // ceiling is left to Better Auth's own disableSignUp refusal.
          if (path !== "/sign-up/email" || settings.managedAuthNewSignupsEnabled === false) return;
          requireSignupChallenge(settings);
          const email = (body as { email?: unknown } | undefined)?.email;
          if (typeof email === "string" && managedAuthSignupEmailNotAllowed(settings, email)) {
            throw new ManagedAuthSignupEmailNotAllowedError();
          }
          if (!(await newSignupsGate.signupsOpen())) throw new ManagedAuthNewSignupsPausedError();
        },
      ),
    },
    advanced: {
      // Better Auth reads client addresses only from request headers. The API
      // strips this header from every inbound request and re-stamps it on
      // managed-auth routes with the trusted source address (transport peer,
      // or the forwarded client when OPENGENI_API_TRUSTED_PROXY_HOPS declares
      // a proxy chain), so callers cannot choose their rate-limit bucket or
      // recorded session address.
      ipAddress: {
        ipAddressHeaders: [TRUSTED_CLIENT_ADDRESS_HEADER],
      },
      useSecureCookies: settings.publicBaseUrl?.startsWith("https://") ?? false,
      // A dynamic base URL (allowed hosts configured) reads the public host
      // from x-forwarded-host, which the bundled web server and ingress set;
      // the host must still match an allowed host. Better Auth 1.6 trusted
      // these headers by default for dynamic base URLs; 1.7 requires opting in.
      ...(splitCsv(settings.betterAuthAllowedHosts).length > 0
        ? { trustedProxyHeaders: true }
        : {}),
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
        // Opengeni's migrations own the auth tables. Better Auth 1.7 otherwise
        // introspects the database before every auth API call, so an
        // unauthenticated request would depend on the database and a benign
        // schema difference would fail every sign-in. The same check runs
        // against the migrated schema in managed-auth-schema.integration.test.ts.
        validateSchema: false,
      },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      modelName: "auth_rate_limits",
      fields: {
        lastRequest: "last_request",
      },
      customRules: MANAGED_AUTH_BETTER_AUTH_RATE_LIMIT_RULES,
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
        enabled: true,
        requireLocalEmailVerified: true,
        trustedProviders: [],
        allowDifferentEmails: false,
      },
      additionalFields: {
        managedLinkIntentId: {
          type: "string",
          fieldName: "managed_link_intent_id",
          input: false,
          returned: false,
        },
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
              ...newSignupsSocialProviderOptions,
            },
          }
        : {}),
      ...(settings.managedAuthGithubClientId && settings.managedAuthGithubClientSecret
        ? {
            github: {
              clientId: settings.managedAuthGithubClientId,
              clientSecret: settings.managedAuthGithubClientSecret,
              ...newSignupsSocialProviderOptions,
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
      // Sign-in, password reset, and verification stay enabled; only new
      // account creation is refused while sign-ups are paused.
      disableSignUp: !settings.managedAuthNewSignupsEnabled,
      // Local managed mode exists so the complete human/org tenancy flow can
      // be exercised without first configuring a transactional-email vendor.
      // Non-local deployments require verification unless explicitly overridden.
      requireEmailVerification,
      revokeSessionsOnPasswordReset: true,
      onExistingUserSignUp: async ({ user }) => {
        if (requireEmailVerification && !user.emailVerified) {
          const url = await verificationUrl(settings, user.email);
          await sendManagedAuthEmail(
            managedEmailTransport,
            emailVerificationMessage(user.email, url),
          );
        }
      },
      sendResetPassword: async ({ user, url }) => {
        await sendManagedAuthEmail(managedEmailTransport, {
          kind: "password_reset",
          to: user.email,
          subject: "Reset your Opengeni password",
          text: `Reset your Opengeni password: ${url}`,
          html: `<p>Reset your Opengeni password:</p><p><a href="${escapeHtml(url)}">Reset password</a></p>`,
        });
      },
    },
    emailVerification: {
      sendOnSignUp: requireEmailVerification,
      // The first successful verification link click signs the user in (a
      // reused link creates no session). Only legacy mode: session-set modes
      // bind sign-in to an isolated browser transaction, and the provider
      // session this would create is discarded there by design.
      autoSignInAfterVerification: settings.managedAuthSessionSetMode === "legacy",
      sendVerificationEmail: async ({ user, url }) => {
        await sendManagedAuthEmail(
          managedEmailTransport,
          emailVerificationMessage(user.email, url),
        );
      },
      afterEmailVerification: async (user) => {
        funnel?.recordEmailVerified();
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
      account: {
        create: {
          before: async (account) => ({
            data: {
              ...account,
              ...(currentManagedSignInConnectIntent()
                ? { managedLinkIntentId: currentManagedSignInConnectIntent() }
                : {}),
            },
          }),
          after: async (account) => {
            if (
              !["google", "github"].includes(account.providerId) ||
              currentManagedSignInConnectIntent()
            )
              return;
            await deliverManagedSignInNotification(db, managedEmailTransport, account.id);
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            if (settings.allowedUserEmails !== undefined) {
              const result = await pool.query<{ email: string; email_verified: boolean }>(
                "select email, email_verified from auth_users where id = $1",
                [session.userId],
              );
              const user = result.rows[0];
              if (
                !user?.email_verified ||
                !managedUserEmailAllowed(settings.allowedUserEmails, user.email)
              )
                return false;
            }
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
            funnel?.recordSignIn();
            recordCurrentManagedAuthSession(session.id);
            if (!shouldDiscardCurrentManagedAuthProviderSession()) return;
            await db.execute(sql`delete from auth_sessions where id = ${session.id}`);
          },
        },
      },
      user: {
        create: {
          before: async (user, context) => {
            try {
              requireSignupChallenge(settings);
              const admission = managedAuthUserCreateAdmission(
                settings,
                user,
                currentManagedAuthProviderId(),
              );
              if (admission === false) {
                if (managedAuthSignupEmailNotAllowed(settings, user.email)) {
                  throw new ManagedAuthSignupEmailNotAllowedError();
                }
                return false;
              }
              if (!(await newSignupsGate.signupsOpen())) {
                throw new ManagedAuthNewSignupsPausedError();
              }
              return admission;
            } catch (error) {
              throw managedAuthOAuthCallbackRefusal(error, context?.path);
            }
          },
          after: async (user, context) => {
            await funnel?.recordSignUp(context);
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
  configureManagedUserAdmission(auth, settings.allowedUserEmails);
  return auth;
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
 * Better Auth's database-backed OAuth state record for a callback's `state`
 * value, or null. Better Auth keeps it in the verification table under
 * `auth-state:<state>` (since 1.7; it does not export that key builder).
 * Every Opengeni reader of OAuth state goes through here, so a future change
 * to the key is one edit, and the integration tests that drive real OAuth
 * callbacks fail loudly if it drifts.
 */
export async function findManagedAuthOAuthState(
  auth: ManagedAuth,
  state: string,
): Promise<{ value: string; expiresAt: Date } | null> {
  const verification = await (
    await auth.$context
  ).internalAdapter.findVerificationValue(`auth-state:${state}`);
  return verification ?? null;
}

/**
 * Resolve Opengeni's server-only login transaction proof from Better Auth's
 * database-backed OAuth state before the provider callback consumes it.
 */
export async function resolveManagedAuthOAuthAttempt(
  auth: ManagedAuth,
  request: Request,
  provider: "google" | "github",
  publicBaseUrl: string,
): Promise<ManagedAuthOAuthAttempt | null> {
  const expectedOrigin = canonicalPublicOrigin(publicBaseUrl);
  if (!expectedOrigin) return null;
  const state = new URL(request.url).searchParams.get("state");
  if (!state) return null;
  const verification = await findManagedAuthOAuthState(auth, state);
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
  const errorURL = typeof stateData.errorURL === "string" ? stateData.errorURL : null;
  if (
    !callbackURL ||
    !errorURL ||
    !managedAuthOAuthReturnMatches(callbackURL, expectedOrigin, value.transactionId, "complete") ||
    !managedAuthOAuthReturnMatches(errorURL, expectedOrigin, value.transactionId, "error")
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

export function managedAuthOAuthReturnMatches(
  raw: string,
  expectedOrigin: string,
  transactionId: string,
  outcome: "complete" | "error",
): boolean {
  try {
    const url = new URL(raw);
    return (
      url.origin === expectedOrigin &&
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
  // Reserved `.invalid` addresses (RFC 2606), such as the placeholder of an
  // account created with only a passkey, can never receive mail.
  if (input.to.toLowerCase().endsWith(".invalid")) return;
  const result = await transport.send({ ...input, from: transport.sender });
  if (result.status !== "sent") throw new Error(`managed email ${result.status}`);
}

// Verification can sign the clicker in (autoSignInAfterVerification), so an
// unsolicited verification email must say plainly that it can be ignored.
function emailVerificationMessage(to: string, url: string): Omit<ManagedEmailMessage, "from"> {
  const ignore = "If you did not create an Opengeni account, ignore this email.";
  return {
    kind: "email_verification",
    to,
    subject: "Verify your Opengeni email",
    text: `Verify your Opengeni email: ${url}\n\n${ignore}`,
    html: `<p>Verify your Opengeni email:</p><p><a href="${escapeHtml(url)}">Verify email</a></p><p>${ignore}</p>`,
  };
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
