import {
  CompleteSelfServiceOrganizationSetupRequest,
  CompleteSelfServiceOrganizationSetupResponse,
  CompleteOrganizationUserSetupRequest,
  CompleteOrganizationUserSetupResponse,
  OrganizationUserSetupPreview,
  PreviewOrganizationUserSetupRequest,
  SelfServiceOrganizationOnboardingStatus,
} from "@opengeni/contracts";
import { getManagedSession, type ApiRouteDeps } from "@opengeni/core";
import {
  completeSelfServiceOrganizationSetup,
  completeOrganizationUserSetup,
  getSelfServiceOrganizationOnboardingState,
  nestedPostgresSqlState,
  preflightOrganizationUserSetup,
  previewOrganizationUserSetup,
} from "@opengeni/db";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import {
  organizationUserSetupRequestFingerprint,
  organizationUserSetupTokenDigest,
  selfServiceOrganizationSetupRequestFingerprint,
} from "../auth/organization-user-setup";
import { hashManagedAuthPassword } from "../auth/managed-auth";

export type ManagedOnboardingRouteOptions = {
  accountSetupLimiter?: { take(key: string): boolean };
  hashPassword?: (password: string) => Promise<string>;
};

const completedSetupReplayPasswordHash = `completed-replay:${"0".repeat(64)}`;

export function registerManagedOnboardingRoutes(
  app: Hono,
  deps: ApiRouteDeps,
  options: ManagedOnboardingRouteOptions = {},
): void {
  const accountSetupLimiter = options.accountSetupLimiter ?? new PublicSetupRateLimiter();
  const hashPassword = options.hashPassword ?? hashManagedAuthPassword;
  app.get("/v1/auth/organization-onboarding", async (context) => {
    const session = await requireManagedHuman(context, deps);
    return context.json(
      SelfServiceOrganizationOnboardingStatus.parse({
        state: await getSelfServiceOrganizationOnboardingState(deps.db, {
          authUserId: session.user.id,
          email: session.user.email,
          emailVerified: session.user.emailVerified,
        }),
      }),
    );
  });

  app.post("/v1/auth/organization-onboarding", async (context) => {
    const session = await requireManagedHuman(context, deps);
    const parsed = CompleteSelfServiceOrganizationSetupRequest.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      throw new HTTPException(422, {
        message: "invalid organization setup request",
      });
    }
    const organizationName = parsed.data.organizationName.trim();
    try {
      const requestFingerprint = await selfServiceOrganizationSetupRequestFingerprint({
        authUserId: session.user.id,
        organizationName,
      });
      return context.json(
        CompleteSelfServiceOrganizationSetupResponse.parse(
          await completeSelfServiceOrganizationSetup(deps.db, {
            authUserId: session.user.id,
            actorSubjectId: `user:${session.user.id}`,
            organizationName,
            operationId: parsed.data.operationId,
            requestFingerprint,
          }),
        ),
      );
    } catch (error) {
      const sqlState = nestedPostgresSqlState(error);
      if (sqlState === "22023") {
        throw new HTTPException(422, {
          message: "invalid organization setup request",
        });
      }
      if (sqlState === "42501") {
        throw new HTTPException(403, {
          message: "verified managed user required",
        });
      }
      if (sqlState === "23505" || sqlState === "55000") {
        throw new HTTPException(409, {
          message: "organization setup is no longer available; refresh to continue",
        });
      }
      throw error;
    }
  });

  app.post("/v1/auth/organization-setup/preview", async (context) => {
    if (deps.settings.productAccessMode !== "managed" || !deps.managedAuth) {
      throw new HTTPException(404, { message: "account setup is unavailable" });
    }
    enforceAccountSetupRateLimit(context, accountSetupLimiter);
    const parsed = PreviewOrganizationUserSetupRequest.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      throw new HTTPException(422, { message: "invalid account setup preview request" });
    }
    return context.json(
      OrganizationUserSetupPreview.parse(
        await previewOrganizationUserSetup(
          deps.db,
          await organizationUserSetupTokenDigest(parsed.data.token),
        ),
      ),
    );
  });

  app.post("/v1/auth/organization-setup", async (context) => {
    if (deps.settings.productAccessMode !== "managed" || !deps.managedAuth) {
      throw new HTTPException(404, { message: "account setup is unavailable" });
    }
    enforceAccountSetupRateLimit(context, accountSetupLimiter);
    const parsed = CompleteOrganizationUserSetupRequest.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!parsed.success) {
      throw new HTTPException(422, {
        message: "invalid account setup request",
      });
    }
    const name = parsed.data.name.trim();
    const tokenDigest = await organizationUserSetupTokenDigest(parsed.data.token);
    const preflight = await preflightOrganizationUserSetup(deps.db, tokenDigest);
    if (preflight === "unavailable") {
      throw new HTTPException(404, {
        message: "account setup link is invalid, expired, or already belongs to an account",
      });
    }
    const requestFingerprint = await organizationUserSetupRequestFingerprint(deps.settings, {
      tokenDigest,
      name,
      password: parsed.data.password,
    });
    const passwordHash =
      preflight === "completed"
        ? completedSetupReplayPasswordHash
        : await hashPassword(parsed.data.password);
    try {
      return context.json(
        CompleteOrganizationUserSetupResponse.parse(
          await completeOrganizationUserSetup(deps.db, {
            tokenDigest,
            operationId: parsed.data.operationId,
            requestFingerprint,
            authUserId: crypto.randomUUID(),
            name,
            passwordHash,
          }),
        ),
      );
    } catch (error) {
      const sqlState = nestedPostgresSqlState(error);
      if (sqlState === "22023") {
        throw new HTTPException(422, {
          message: "invalid account setup request",
        });
      }
      if (sqlState === "23505") {
        throw new HTTPException(409, {
          message: "account setup request changed; reopen the original link and try again",
        });
      }
      if (sqlState === "P0002" || sqlState === "42501" || sqlState === "55000") {
        throw new HTTPException(404, {
          message: "account setup link is invalid, expired, or already belongs to an account",
        });
      }
      throw error;
    }
  });
}

function enforceAccountSetupRateLimit(
  context: Context,
  limiter: { take(key: string): boolean },
): void {
  let allowed = false;
  try {
    allowed = limiter.take(accountSetupClientKey(context));
  } catch {
    // A public credential-setting endpoint must fail closed if its abuse gate
    // cannot make a decision.
  }
  if (!allowed) {
    throw new HTTPException(429, { message: "too many account setup requests; slow down" });
  }
}

function accountSetupClientKey(context: Context): string {
  const forwarded = context.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  const address = forwarded || context.req.header("x-real-ip")?.trim() || "unknown";
  return address.slice(0, 128);
}

/**
 * Bounded application-tier protection for the public setup bearer endpoint.
 * The global bucket prevents spoofed/high-cardinality client keys from
 * multiplying password-hash work, while the per-client bucket limits bursts.
 * A full key map rejects new clients until an idle bucket can be pruned.
 */
export class PublicSetupRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();
  private global: { tokens: number; updatedAt: number };

  constructor(
    private readonly options: {
      globalCapacity?: number;
      globalRefillPerSecond?: number;
      clientCapacity?: number;
      clientRefillPerSecond?: number;
      maxClientKeys?: number;
      now?: () => number;
    } = {},
  ) {
    this.global = {
      tokens: options.globalCapacity ?? 50,
      updatedAt: options.now?.() ?? Date.now(),
    };
  }

  take(key: string): boolean {
    const now = this.options.now?.() ?? Date.now();
    const globalCapacity = this.options.globalCapacity ?? 50;
    if (
      !takeSetupRateLimitToken(
        this.global,
        globalCapacity,
        this.options.globalRefillPerSecond ?? 5,
        now,
      )
    ) {
      return false;
    }
    const clientCapacity = this.options.clientCapacity ?? 5;
    const maxClientKeys = this.options.maxClientKeys ?? 2_048;
    let bucket = this.buckets.get(key);
    if (!bucket && this.buckets.size >= maxClientKeys) {
      for (const [candidateKey, candidate] of this.buckets) {
        refillSetupRateLimitBucket(
          candidate,
          clientCapacity,
          this.options.clientRefillPerSecond ?? 0.1,
          now,
        );
        if (candidate.tokens >= clientCapacity) this.buckets.delete(candidateKey);
      }
      if (this.buckets.size >= maxClientKeys) return false;
    }
    bucket ??= { tokens: clientCapacity, updatedAt: now };
    const allowed = takeSetupRateLimitToken(
      bucket,
      clientCapacity,
      this.options.clientRefillPerSecond ?? 0.1,
      now,
    );
    this.buckets.set(key, bucket);
    return allowed;
  }
}

function takeSetupRateLimitToken(
  bucket: { tokens: number; updatedAt: number },
  capacity: number,
  refillPerSecond: number,
  now: number,
): boolean {
  refillSetupRateLimitBucket(bucket, capacity, refillPerSecond, now);
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

function refillSetupRateLimitBucket(
  bucket: { tokens: number; updatedAt: number },
  capacity: number,
  refillPerSecond: number,
  now: number,
): void {
  const elapsedSeconds = Math.max(0, (now - bucket.updatedAt) / 1_000);
  bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSeconds * refillPerSecond);
  bucket.updatedAt = now;
}

async function requireManagedHuman(context: Context, deps: ApiRouteDeps) {
  if (
    deps.settings.productAccessMode !== "managed" ||
    !deps.managedAuth ||
    !context.req.header("cookie") ||
    context.req.header("authorization")
  ) {
    throw new HTTPException(401, { message: "managed human session required" });
  }
  const session = await getManagedSession(context, deps.managedAuth, {
    db: deps.db,
  });
  if (!session?.user) {
    throw new HTTPException(401, { message: "managed human session required" });
  }
  return session;
}
