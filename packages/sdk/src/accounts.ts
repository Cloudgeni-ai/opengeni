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
  ) {
    super(code);
  }
}

export class BrowserAccountsClient implements BrowserAccountsClientLike {
  readonly #baseUrl: string;
  readonly #fetch: BrowserAccountsFetch;
  #projection: ManagedAuthSessionSetProjectionType | null = null;

  constructor(options: BrowserAccountsClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async getSessionSet(): Promise<ManagedAuthSessionSetProjectionType> {
    return this.#remember(
      ManagedAuthSessionSetProjection.parse(await this.#request("GET", "/v1/auth/session-set")),
    );
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
    const response = CompleteManagedAuthLoginTransactionResponse.parse(
      await this.#mutation(
        "POST",
        "/v1/auth/session-set/transactions/email-password",
        CompleteManagedAuthEmailPasswordTransactionRequest,
        request,
      ),
    );
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
    this.#projection = null;
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
    const received = ManagedAuthSessionSetProjection.parse(
      await this.#mutation(method, path, schema, request),
    );
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
    return await this.#request(method, path, body, {
      "x-opengeni-session-csrf": projection.csrfToken,
      "x-opengeni-actor-epoch": projection.actorEpoch,
    });
  }

  async #request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<unknown> {
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
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
    const value = await response.json().catch(() => null);
    if (!response.ok) {
      const code = managedAuthErrorCode(value) ?? `http_${response.status}`;
      throw new BrowserAccountsApiError(response.status, code);
    }
    return value;
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
