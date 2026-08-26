import {
  BeginManagedAuthLoginTransactionRequest,
  BootstrapManagedAuthSessionSetRequest,
  CancelManagedAuthLoginTransactionRequest,
  CompleteManagedAuthEmailPasswordTransactionRequest,
  CompleteManagedAuthLoginTransactionResponse,
  LogoutManagedAuthLoginSlotRequest,
  LogoutManagedAuthSessionSetRequest,
  MANAGED_AUTH_SESSION_SET_API_CONTRACT_HEADER,
  MANAGED_AUTH_SESSION_SET_API_CONTRACT_REVISION,
  ManagedAuthDeepLinkResolution,
  ManagedAuthLoginTransaction,
  ManagedAuthLogoutAllReceipt,
  ManagedAuthSessionSetProjection,
  ManagedAuthSessionSetErrorCode,
  ResolveManagedAuthDeepLinkRequest,
  SelectManagedAuthLoginSlotRequest,
  type BeginManagedAuthLoginTransactionRequest as BeginManagedAuthLoginTransactionRequestType,
  type BootstrapManagedAuthSessionSetRequest as BootstrapManagedAuthSessionSetRequestType,
  type CancelManagedAuthLoginTransactionRequest as CancelManagedAuthLoginTransactionRequestType,
  type CompleteManagedAuthEmailPasswordTransactionRequest as CompleteManagedAuthEmailPasswordTransactionRequestType,
  type CompleteManagedAuthLoginTransactionResponse as CompleteManagedAuthLoginTransactionResponseType,
  type LogoutManagedAuthLoginSlotRequest as LogoutManagedAuthLoginSlotRequestType,
  type LogoutManagedAuthSessionSetRequest as LogoutManagedAuthSessionSetRequestType,
  type ManagedAuthDeepLinkResolution as ManagedAuthDeepLinkResolutionType,
  type ManagedAuthLoginTransaction as ManagedAuthLoginTransactionType,
  type ManagedAuthLogoutAllReceipt as ManagedAuthLogoutAllReceiptType,
  type ManagedAuthSessionSetProjection as ManagedAuthSessionSetProjectionType,
  type ResolveManagedAuthDeepLinkRequest as ResolveManagedAuthDeepLinkRequestType,
  type SelectManagedAuthLoginSlotRequest as SelectManagedAuthLoginSlotRequestType,
} from "@opengeni/contracts/managed-auth-session-sets";
import type { z } from "zod";

export type BrowserAccountsFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type BrowserAccountsClientOptions = {
  baseUrl: string;
  fetch?: BrowserAccountsFetch;
};

export interface BrowserAccountsClientLike {
  getSessionSet(): Promise<ManagedAuthSessionSetProjectionType>;
  reconcileSessionSetAuthority(): Promise<ManagedAuthSessionSetProjectionType>;
  bootstrapSessionSet(
    request: BootstrapManagedAuthSessionSetRequestType,
  ): Promise<ManagedAuthSessionSetProjectionType>;
  beginLoginTransaction(
    request: BeginManagedAuthLoginTransactionRequestType,
  ): Promise<ManagedAuthLoginTransactionType>;
  completeEmailPasswordTransaction(
    request: CompleteManagedAuthEmailPasswordTransactionRequestType,
  ): Promise<CompleteManagedAuthLoginTransactionResponseType>;
  cancelLoginTransaction(
    request: CancelManagedAuthLoginTransactionRequestType,
  ): Promise<ManagedAuthSessionSetProjectionType>;
  selectLoginSlot(
    request: SelectManagedAuthLoginSlotRequestType,
  ): Promise<ManagedAuthSessionSetProjectionType>;
  logoutLoginSlot(
    request: LogoutManagedAuthLoginSlotRequestType,
  ): Promise<ManagedAuthSessionSetProjectionType>;
  logoutSessionSet(
    request: LogoutManagedAuthSessionSetRequestType,
  ): Promise<ManagedAuthLogoutAllReceiptType>;
  resolveDeepLink(
    request: ResolveManagedAuthDeepLinkRequestType,
  ): Promise<ManagedAuthDeepLinkResolutionType>;
}

export class BrowserAccountsApiError extends Error {
  readonly name = "BrowserAccountsApiError";
  constructor(
    readonly status: number,
    readonly code: string,
    options?: { cause?: unknown },
  ) {
    super(code, options?.cause === undefined ? undefined : { cause: options.cause });
  }
}

export class BrowserAccountsClient implements BrowserAccountsClientLike {
  readonly #baseUrl: string;
  readonly #fetch: BrowserAccountsFetch;
  // CSRF is generation-bound. Exact idempotent replay must retain the
  // admission envelope even after an authority reread observes a newer clock.
  readonly #mutationAdmissions = new Map<
    string,
    { signature: string; csrfToken: string; actorEpoch: string }
  >();
  #projection: ManagedAuthSessionSetProjectionType | null = null;
  #authorityReadEpoch = 0;
  #authorityReconciliation: Promise<ManagedAuthSessionSetProjectionType> | null = null;

  constructor(options: BrowserAccountsClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async getSessionSet(): Promise<ManagedAuthSessionSetProjectionType> {
    const activeReconciliation = this.#authorityReconciliation;
    if (activeReconciliation) return await activeReconciliation;
    const readEpoch = this.#authorityReadEpoch;
    const received = await this.#readSessionSet();
    if (readEpoch !== this.#authorityReadEpoch) {
      return this.#authorityReconciliation
        ? await this.#authorityReconciliation
        : (this.#projection ?? (await this.getSessionSet()));
    }
    return this.#remember(received);
  }

  async reconcileSessionSetAuthority(): Promise<ManagedAuthSessionSetProjectionType> {
    if (this.#authorityReconciliation) return await this.#authorityReconciliation;
    const previous = this.#projection;
    const readEpoch = ++this.#authorityReadEpoch;
    const reconciliation = this.#reconcileSessionSetAuthority(previous, readEpoch);
    this.#authorityReconciliation = reconciliation;
    try {
      return await reconciliation;
    } finally {
      if (this.#authorityReconciliation === reconciliation) {
        this.#authorityReconciliation = null;
      }
    }
  }

  async bootstrapSessionSet(request: BootstrapManagedAuthSessionSetRequestType) {
    return this.#projectionResponse(
      "POST",
      "/v1/auth/session-set/bootstrap",
      BootstrapManagedAuthSessionSetRequest,
      request,
    );
  }

  async beginLoginTransaction(request: BeginManagedAuthLoginTransactionRequestType) {
    return ManagedAuthLoginTransaction.parse(
      await this.#mutation(
        "POST",
        "/v1/auth/session-set/transactions",
        BeginManagedAuthLoginTransactionRequest,
        request,
      ),
    );
  }

  async completeEmailPasswordTransaction(
    request: CompleteManagedAuthEmailPasswordTransactionRequestType,
  ) {
    const authorityReadEpoch = this.#authorityReadEpoch;
    const response = CompleteManagedAuthLoginTransactionResponse.parse(
      await this.#mutation(
        "POST",
        "/v1/auth/session-set/transactions/email-password",
        CompleteManagedAuthEmailPasswordTransactionRequest,
        request,
      ),
    );
    if (authorityReadEpoch !== this.#authorityReadEpoch) {
      return { ...response, projection: await this.getSessionSet() };
    }
    const remembered = this.#remember(response.projection);
    if (remembered !== response.projection) {
      return { ...response, projection: await this.getSessionSet() };
    }
    return response;
  }

  async cancelLoginTransaction(request: CancelManagedAuthLoginTransactionRequestType) {
    return this.#projectionResponse(
      "DELETE",
      `/v1/auth/session-set/transactions/${encodeURIComponent(request.transactionId)}`,
      CancelManagedAuthLoginTransactionRequest,
      request,
    );
  }

  async selectLoginSlot(request: SelectManagedAuthLoginSlotRequestType) {
    return this.#projectionResponse(
      "POST",
      "/v1/auth/session-set/select",
      SelectManagedAuthLoginSlotRequest,
      request,
    );
  }

  async logoutLoginSlot(request: LogoutManagedAuthLoginSlotRequestType) {
    return this.#projectionResponse(
      "POST",
      "/v1/auth/session-set/logout-one",
      LogoutManagedAuthLoginSlotRequest,
      request,
    );
  }

  async logoutSessionSet(request: LogoutManagedAuthSessionSetRequestType) {
    const receipt = ManagedAuthLogoutAllReceipt.parse(
      await this.#mutation(
        "POST",
        "/v1/auth/session-set/logout-all",
        LogoutManagedAuthSessionSetRequest,
        request,
      ),
    );
    this.#authorityReadEpoch += 1;
    this.#projection = null;
    this.#mutationAdmissions.clear();
    return receipt;
  }

  async resolveDeepLink(request: ResolveManagedAuthDeepLinkRequestType) {
    return ManagedAuthDeepLinkResolution.parse(
      await this.#mutation(
        "POST",
        "/v1/auth/session-set/deep-link/resolve",
        ResolveManagedAuthDeepLinkRequest,
        request,
      ),
    );
  }

  async #projectionResponse<S extends z.ZodType>(
    method: "POST" | "DELETE",
    path: string,
    schema: S,
    request: z.infer<S>,
  ): Promise<ManagedAuthSessionSetProjectionType> {
    const authorityReadEpoch = this.#authorityReadEpoch;
    const received = ManagedAuthSessionSetProjection.parse(
      await this.#mutation(method, path, schema, request),
    );
    if (authorityReadEpoch !== this.#authorityReadEpoch) return await this.getSessionSet();
    const remembered = this.#remember(received);
    // An exact replay may legitimately return its older durable receipt after
    // another tab has advanced this in-memory client. Reconcile from authority
    // instead of presenting that receipt as the current actor projection.
    return remembered === received ? received : await this.getSessionSet();
  }

  async #mutation<S extends z.ZodType>(
    method: "POST" | "DELETE",
    path: string,
    schema: S,
    request: z.infer<S>,
  ): Promise<unknown> {
    const body = schema.parse(request);
    const projection = this.#projection;
    if (!projection) throw new BrowserAccountsApiError(409, "session_set_projection_required");
    const operationId = mutationOperationId(body);
    const signature = operationId ? JSON.stringify([method, path, body]) : null;
    const retained = operationId ? this.#mutationAdmissions.get(operationId) : null;
    if (retained && retained.signature !== signature) {
      throw new BrowserAccountsApiError(409, "operation_reused");
    }
    const admission =
      retained ??
      ({
        signature: signature ?? "",
        csrfToken: projection.csrfToken,
        actorEpoch: projection.actorEpoch,
      } as const);
    if (operationId && !retained) {
      this.#mutationAdmissions.set(operationId, admission);
      if (this.#mutationAdmissions.size > 64) {
        this.#mutationAdmissions.delete(this.#mutationAdmissions.keys().next().value!);
      }
    }
    return await this.#request(method, path, body, {
      "x-opengeni-session-csrf": admission.csrfToken,
      "x-opengeni-actor-epoch": admission.actorEpoch,
    });
  }

  async #request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        credentials: "include",
        headers: {
          accept: "application/json",
          [MANAGED_AUTH_SESSION_SET_API_CONTRACT_HEADER]:
            MANAGED_AUTH_SESSION_SET_API_CONTRACT_REVISION,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      if (method !== "GET") {
        throw new BrowserAccountsApiError(503, "operation_outcome_unknown", { cause });
      }
      throw cause;
    }
    let parsed = true;
    const value = await response.json().catch(() => {
      parsed = false;
      return null;
    });
    if (!response.ok) {
      const code = managedAuthErrorCode(value) ?? `http_${response.status}`;
      throw new BrowserAccountsApiError(response.status, code);
    }
    if (!parsed && method !== "GET") {
      throw new BrowserAccountsApiError(503, "operation_outcome_unknown");
    }
    return value;
  }

  async #readSessionSet(): Promise<ManagedAuthSessionSetProjectionType> {
    return ManagedAuthSessionSetProjection.parse(
      await this.#request("GET", "/v1/auth/session-set"),
    );
  }

  async #reconcileSessionSetAuthority(
    previous: ManagedAuthSessionSetProjectionType | null,
    readEpoch: number,
  ): Promise<ManagedAuthSessionSetProjectionType> {
    const first = await this.#readSessionSet();
    const second = await this.#readSessionSet();
    if (readEpoch !== this.#authorityReadEpoch) {
      return await this.#reconcileSessionSetAuthority(this.#projection, this.#authorityReadEpoch);
    }
    if (this.#projection !== previous) return this.#remember(second);
    if (!previous || compareProjectionClock(second, previous) >= 0) {
      return this.#remember(second);
    }
    if (compareProjectionClock(first, previous) < 0 && compareProjectionClock(second, first) >= 0) {
      // Same-authority clocks never decrease. Two sequential no-store reads
      // that both remain below the remembered clock therefore prove that the
      // HttpOnly authority rotated; the second may already have advanced from
      // the fresh authority's initial 1/1 projection.
      this.#projection = second;
      this.#mutationAdmissions.clear();
      return second;
    }
    return previous;
  }

  #remember(projection: ManagedAuthSessionSetProjectionType) {
    const current = this.#projection;
    if (!current || compareProjectionClock(projection, current) >= 0) {
      this.#projection = projection;
      return projection;
    }
    return current;
  }
}

function mutationOperationId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const operationId = (value as { operationId?: unknown }).operationId;
  return typeof operationId === "string" ? operationId : null;
}

function compareProjectionClock(
  left: Pick<ManagedAuthSessionSetProjectionType, "actorEpoch" | "generation">,
  right: Pick<ManagedAuthSessionSetProjectionType, "actorEpoch" | "generation">,
): number {
  const actorDelta = BigInt(left.actorEpoch) - BigInt(right.actorEpoch);
  if (actorDelta !== 0n) return actorDelta > 0n ? 1 : -1;
  const generationDelta = BigInt(left.generation) - BigInt(right.generation);
  return generationDelta === 0n ? 0 : generationDelta > 0n ? 1 : -1;
}

function managedAuthErrorCode(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const error = (value as { error?: unknown }).error;
  if (error && typeof error === "object") {
    const details = (error as { details?: unknown }).details;
    if (details && typeof details === "object") {
      const parsed = ManagedAuthSessionSetErrorCode.safeParse(
        (details as { managedAuthCode?: unknown }).managedAuthCode,
      );
      if (parsed.success) return parsed.data;
    }
  }
  const legacy = (value as { message?: unknown }).message;
  const parsed = ManagedAuthSessionSetErrorCode.safeParse(legacy);
  return parsed.success ? parsed.data : null;
}

export function createBrowserAccountsClient(
  options: BrowserAccountsClientOptions,
): BrowserAccountsClient {
  return new BrowserAccountsClient(options);
}

export type {
  BeginManagedAuthLoginTransactionRequestType as BeginManagedAuthLoginTransactionRequest,
  BootstrapManagedAuthSessionSetRequestType as BootstrapManagedAuthSessionSetRequest,
  CancelManagedAuthLoginTransactionRequestType as CancelManagedAuthLoginTransactionRequest,
  CompleteManagedAuthEmailPasswordTransactionRequestType as CompleteManagedAuthEmailPasswordTransactionRequest,
  CompleteManagedAuthLoginTransactionResponseType as CompleteManagedAuthLoginTransactionResponse,
  LogoutManagedAuthLoginSlotRequestType as LogoutManagedAuthLoginSlotRequest,
  LogoutManagedAuthSessionSetRequestType as LogoutManagedAuthSessionSetRequest,
  ManagedAuthDeepLinkResolutionType as ManagedAuthDeepLinkResolution,
  ManagedAuthLoginTransactionType as ManagedAuthLoginTransaction,
  ManagedAuthLogoutAllReceiptType as ManagedAuthLogoutAllReceipt,
  ManagedAuthSessionSetProjectionType as ManagedAuthSessionSetProjection,
  ResolveManagedAuthDeepLinkRequestType as ResolveManagedAuthDeepLinkRequest,
  SelectManagedAuthLoginSlotRequestType as SelectManagedAuthLoginSlotRequest,
};
