import type { ApiRouteDeps } from "@opengeni/core";
import type { Settings } from "@opengeni/config";
import {
  FIKEN_CREDENTIAL_LABEL,
  FIKEN_CREDENTIAL_ROLE,
  FIKEN_PROVIDER_DOMAIN,
  FikenOAuthStartResponse,
  type AccessGrant,
  type ConnectionMetadata,
  type FikenCompanySummary,
  type FikenConnectionMetadata,
  type FikenOAuthStartRequest,
} from "@opengeni/contracts";
import {
  fikenConnectionMetadata,
  hasPermission,
  isFikenConnection,
  preferredFikenConnection,
  requireEnvironmentEncryption,
} from "@opengeni/core";
import {
  buildConnectionTokenResolver,
  consumeIntegrationOAuthStateNonce,
  createConnection,
  encryptEnvironmentValue,
  getConnectionMetadata,
  getWorkspaceGrant,
  listConnectionsMetadata,
  recordAuditEvent,
  setConnectionStatus,
  updateConnection,
  type Database,
} from "@opengeni/db";
import { createSignedState, readSignedState } from "@opengeni/github";
import { readResponseJsonBounded, type FetchLike } from "@opengeni/network";
import { HTTPException } from "hono/http-exception";
import {
  integrationBaseUrl,
  oauthStateTtlMs,
  requireIntegrationsStateSecret,
} from "./oauth-client";

const FIKEN_API_BASE = "https://api.fiken.no/api/v2";
const FIKEN_TIMEOUT_MS = 15_000;
const FIKEN_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;
const FIKEN_ERROR_BODY_MAX_BYTES = 64 * 1024;
const FIKEN_PROVIDER_MESSAGE_MAX_CHARS = 500;
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;
const MAX_VERIFIED_COMPANIES = 100;
const MAX_DRAFT_LINES = 100;

// Fiken company slugs as issued by Fiken: lowercase alphanumerics and dashes.
const COMPANY_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;

export type FikenOperation =
  | "companies.list"
  | "contacts.list"
  | "contact.create"
  | "products.list"
  | "invoices.list"
  | "invoice.get"
  | "invoice_draft.create"
  | "bank_accounts.list"
  | "purchases.list"
  | "sales.list";

export class FikenProviderError extends Error {
  constructor(
    readonly code: string,
    readonly status: number | null = null,
    providerMessage: string | null = null,
  ) {
    super(
      providerMessage
        ? `Fiken request failed: ${code}: ${providerMessage}`
        : `Fiken request failed: ${code}`,
    );
    this.name = "FikenProviderError";
  }
}

export class FikenCredentialVerificationError extends HTTPException {
  constructor(message: string) {
    super(422, { message });
    this.name = "FikenCredentialVerificationError";
  }
}

export type FikenPage = {
  page: number;
  pageSize: number;
  pageCount: number | null;
  resultCount: number | null;
};

type FikenContext = {
  accountId: string;
  workspaceId: string;
  subjectId: string | null;
  sessionId: string | null;
};

/**
 * Fiken allows only a single concurrent API request per credential; concurrent
 * requests can 429 and repeated violations can get the token banned. Serialize
 * every provider call through a per-connection promise chain in this process.
 */
const connectionRequestChains = new Map<string, Promise<unknown>>();

async function serializedPerConnection<T>(connectionId: string, run: () => Promise<T>): Promise<T> {
  const previous = connectionRequestChains.get(connectionId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(run);
  connectionRequestChains.set(connectionId, next);
  void next
    .catch(() => undefined)
    .finally(() => {
      if (connectionRequestChains.get(connectionId) === next) {
        connectionRequestChains.delete(connectionId);
      }
    });
  return await next;
}

/**
 * Validates a pasted Fiken personal API token before it enters encrypted
 * storage, and discovers the companies it can act on. The companies list is
 * the connection's bounded metadata; company slugs are re-validated by Fiken
 * itself on every later call.
 */
export async function verifyFikenApiToken(
  token: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ companies: FikenCompanySummary[] }> {
  const result = await fetchFikenCompanies(token, fetchImpl);
  switch (result.outcome) {
    case "ok":
      return { companies: result.companies };
    case "unreachable":
      throw new FikenCredentialVerificationError("Fiken could not be reached to verify the token");
    case "rejected":
      throw new FikenCredentialVerificationError(
        "Fiken rejected the API token. Create a personal API token under Rediger konto -> API in Fiken and make sure API module access is active.",
      );
    case "http_error":
      throw new FikenCredentialVerificationError(
        `Fiken token verification failed with HTTP ${result.status}`,
      );
    case "invalid_response":
      throw new FikenCredentialVerificationError("Fiken returned an unexpected companies response");
    case "no_companies":
      throw new FikenCredentialVerificationError(
        "The Fiken token is valid but has API access to no company. Order API module access in Fiken first.",
      );
  }
}

type FikenCompaniesResult =
  | { outcome: "ok"; companies: FikenCompanySummary[] }
  | { outcome: "unreachable" }
  | { outcome: "rejected" }
  | { outcome: "http_error"; status: number }
  | { outcome: "invalid_response" }
  | { outcome: "no_companies" };

/** Bounded discovery of the companies a bearer credential can act on. */
async function fetchFikenCompanies(
  bearerToken: string,
  fetchImpl: FetchLike,
): Promise<FikenCompaniesResult> {
  let response: Response;
  try {
    response = await fetchImpl(`${FIKEN_API_BASE}/companies?pageSize=${MAX_PAGE_SIZE}`, {
      method: "GET",
      headers: { authorization: `Bearer ${bearerToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(FIKEN_TIMEOUT_MS),
    });
  } catch {
    return { outcome: "unreachable" };
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => undefined);
    return { outcome: "rejected" };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { outcome: "http_error", status: response.status };
  }
  let payload: unknown;
  try {
    payload = await readResponseJsonBounded<unknown>(
      response,
      FIKEN_RESPONSE_MAX_BYTES,
      "Fiken companies response",
    );
  } catch {
    return { outcome: "invalid_response" };
  }
  if (!Array.isArray(payload)) {
    return { outcome: "invalid_response" };
  }
  const companies: FikenCompanySummary[] = [];
  for (const entry of payload.slice(0, MAX_VERIFIED_COMPANIES)) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const slug = typeof record.slug === "string" ? record.slug : null;
    if (!slug || !COMPANY_SLUG_PATTERN.test(slug)) continue;
    companies.push({
      slug,
      name: typeof record.name === "string" && record.name.length > 0 ? record.name : slug,
      organizationNumber:
        typeof record.organizationNumber === "string" ? record.organizationNumber : null,
    });
  }
  if (companies.length === 0) {
    return { outcome: "no_companies" };
  }
  return { outcome: "ok", companies };
}

export function fikenCredentialBundle(token: string): Record<string, unknown> {
  // The api_key broker shape: headers injected verbatim on provider requests.
  return { headers: { authorization: `Bearer ${token}` } };
}

export async function resolveFikenConnectionForTool(input: {
  db: Database;
  grant: AccessGrant;
  sessionId: string | null;
  requestedConnectionId?: string;
}): Promise<{
  connection: ConnectionMetadata;
  metadata: FikenConnectionMetadata;
  context: FikenContext;
}> {
  const connection = input.requestedConnectionId
    ? await getConnectionMetadata(
        input.db,
        input.grant.workspaceId,
        input.requestedConnectionId,
        null,
      )
    : preferredFikenConnection(
        (await listConnectionsMetadata(input.db, input.grant.workspaceId, null)).filter(
          isFikenConnection,
        ),
      );
  if (!connection || !isFikenConnection(connection)) {
    throw new Error(
      "no Fiken connection is available in this workspace; connect Fiken from the Capabilities page first",
    );
  }
  if (connection.status !== "active") {
    throw new Error(
      `the Fiken connection is ${connection.status}; reconnect it with a fresh API token from the Capabilities page`,
    );
  }
  const metadata = fikenConnectionMetadata(connection.metadata);
  if (!metadata) {
    throw new Error("Fiken connection metadata is invalid");
  }
  return {
    connection,
    metadata,
    context: {
      accountId: input.grant.accountId,
      workspaceId: input.grant.workspaceId,
      subjectId: input.grant.subjectId,
      sessionId: input.sessionId,
    },
  };
}

export type FikenListInput = {
  companySlug?: string | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
};

export class FikenClient {
  private readonly resolveCredential: ReturnType<typeof buildConnectionTokenResolver>;

  constructor(
    private readonly db: Database,
    private readonly settings: Settings,
    private readonly connection: ConnectionMetadata,
    private readonly metadata: FikenConnectionMetadata,
    private readonly context: FikenContext,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    // OAuth-kind connections refresh through the generic broker; route that
    // token-endpoint transport through the same injectable Fiken fetch.
    this.resolveCredential = buildConnectionTokenResolver(db, settings, undefined, {
      refreshTransport: { fetchImpl },
    });
  }

  async listCompanies(input: { page?: number; pageSize?: number } = {}) {
    const { payload, page } = await this.request("companies.list", "GET", "/companies", {
      query: pageQuery(input),
    });
    return { companies: projectArray(payload), page };
  }

  async listContacts(
    input: FikenListInput & {
      name?: string | undefined;
      email?: string | undefined;
      organizationNumber?: string | undefined;
      customer?: boolean | undefined;
      supplier?: boolean | undefined;
      inactive?: boolean | undefined;
    },
  ) {
    const slug = this.companySlugFor(input.companySlug);
    const { payload, page } = await this.request(
      "contacts.list",
      "GET",
      `/companies/${slug}/contacts`,
      {
        query: {
          ...pageQuery(input),
          ...(input.name ? { name: input.name } : {}),
          ...(input.email ? { email: input.email } : {}),
          ...(input.organizationNumber ? { organizationNumber: input.organizationNumber } : {}),
          ...(input.customer !== undefined ? { customer: String(input.customer) } : {}),
          ...(input.supplier !== undefined ? { supplier: String(input.supplier) } : {}),
          ...(input.inactive !== undefined ? { inactive: String(input.inactive) } : {}),
        },
      },
    );
    return { companySlug: slug, contacts: projectArray(payload), page };
  }

  async createContact(input: {
    companySlug?: string | undefined;
    name: string;
    email?: string | undefined;
    organizationNumber?: string | undefined;
    phoneNumber?: string | undefined;
    customer?: boolean | undefined;
    supplier?: boolean | undefined;
  }) {
    const slug = this.companySlugFor(input.companySlug);
    const { locationId } = await this.request(
      "contact.create",
      "POST",
      `/companies/${slug}/contacts`,
      {
        body: {
          name: input.name,
          ...(input.email ? { email: input.email } : {}),
          ...(input.organizationNumber ? { organizationNumber: input.organizationNumber } : {}),
          ...(input.phoneNumber ? { phoneNumber: input.phoneNumber } : {}),
          ...(input.customer !== undefined ? { customer: input.customer } : {}),
          ...(input.supplier !== undefined ? { supplier: input.supplier } : {}),
        },
      },
    );
    return { companySlug: slug, contactId: locationId, receipt: this.receipt("contact.create") };
  }

  async listProducts(
    input: FikenListInput & { name?: string | undefined; active?: boolean | undefined },
  ) {
    const slug = this.companySlugFor(input.companySlug);
    const { payload, page } = await this.request(
      "products.list",
      "GET",
      `/companies/${slug}/products`,
      {
        query: {
          ...pageQuery(input),
          ...(input.name ? { name: input.name } : {}),
          ...(input.active !== undefined ? { active: String(input.active) } : {}),
        },
      },
    );
    return { companySlug: slug, products: projectArray(payload), page };
  }

  async listInvoices(
    input: FikenListInput & {
      issueDateGe?: string | undefined;
      issueDateLe?: string | undefined;
      customerId?: number | undefined;
      settled?: boolean | undefined;
      invoiceNumber?: string | undefined;
    },
  ) {
    const slug = this.companySlugFor(input.companySlug);
    const { payload, page } = await this.request(
      "invoices.list",
      "GET",
      `/companies/${slug}/invoices`,
      {
        query: {
          ...pageQuery(input),
          ...(input.issueDateGe ? { issueDateGe: input.issueDateGe } : {}),
          ...(input.issueDateLe ? { issueDateLe: input.issueDateLe } : {}),
          ...(input.customerId !== undefined ? { customerId: String(input.customerId) } : {}),
          ...(input.settled !== undefined ? { settled: String(input.settled) } : {}),
          ...(input.invoiceNumber ? { invoiceNumber: input.invoiceNumber } : {}),
        },
      },
    );
    return { companySlug: slug, invoices: projectArray(payload), page };
  }

  async getInvoice(input: { companySlug?: string | undefined; invoiceId: number }) {
    const slug = this.companySlugFor(input.companySlug);
    const { payload } = await this.request(
      "invoice.get",
      "GET",
      `/companies/${slug}/invoices/${encodeURIComponent(String(input.invoiceId))}`,
      {},
    );
    return { companySlug: slug, invoice: projectRecord(payload) };
  }

  async createInvoiceDraft(input: {
    companySlug?: string | undefined;
    operationId: string;
    customerId: number;
    daysUntilDueDate: number;
    invoiceText?: string | undefined;
    yourReference?: string | undefined;
    ourReference?: string | undefined;
    currency?: string | undefined;
    bankAccountNumber?: string | undefined;
    lines: Array<{
      description?: string | undefined;
      productId?: number | undefined;
      unitPriceCents?: number | undefined;
      vatType?: string | undefined;
      quantity: number;
      discountPercent?: number | undefined;
      incomeAccount?: string | undefined;
      comment?: string | undefined;
    }>;
  }) {
    const slug = this.companySlugFor(input.companySlug);
    if (input.lines.length === 0 || input.lines.length > MAX_DRAFT_LINES) {
      throw new FikenProviderError("invalid_lines");
    }
    // Fiken drafts carry a caller-chosen uuid: reusing the operationId as that
    // uuid makes retries observable. A retry first looks the draft up and
    // returns the existing row instead of creating a duplicate.
    const existing = await this.request(
      "invoice_draft.create",
      "GET",
      `/companies/${slug}/invoices/drafts`,
      { query: { uuid: input.operationId } },
    );
    const existingDrafts = projectArray(existing.payload);
    if (existingDrafts.length > 0) {
      return {
        companySlug: slug,
        draft: existingDrafts[0],
        alreadyExisted: true,
        receipt: this.receipt("invoice_draft.create", input.operationId),
      };
    }
    const { locationId } = await this.request(
      "invoice_draft.create",
      "POST",
      `/companies/${slug}/invoices/drafts`,
      {
        body: {
          type: "invoice",
          uuid: input.operationId,
          customerId: input.customerId,
          daysUntilDueDate: input.daysUntilDueDate,
          ...(input.invoiceText ? { invoiceText: input.invoiceText } : {}),
          ...(input.yourReference ? { yourReference: input.yourReference } : {}),
          ...(input.ourReference ? { ourReference: input.ourReference } : {}),
          ...(input.currency ? { currency: input.currency } : {}),
          ...(input.bankAccountNumber ? { bankAccountNumber: input.bankAccountNumber } : {}),
          lines: input.lines.map((line) => ({
            ...(line.description ? { description: line.description } : {}),
            ...(line.productId !== undefined ? { productId: line.productId } : {}),
            ...(line.unitPriceCents !== undefined ? { unitPrice: line.unitPriceCents } : {}),
            ...(line.vatType ? { vatType: line.vatType } : {}),
            quantity: line.quantity,
            ...(line.discountPercent !== undefined ? { discount: line.discountPercent } : {}),
            ...(line.incomeAccount ? { incomeAccount: line.incomeAccount } : {}),
            ...(line.comment ? { comment: line.comment } : {}),
          })),
        },
      },
    );
    return {
      companySlug: slug,
      draftId: locationId,
      alreadyExisted: false,
      receipt: this.receipt("invoice_draft.create", input.operationId),
    };
  }

  async listBankAccounts(input: FikenListInput & { inactive?: boolean | undefined }) {
    const slug = this.companySlugFor(input.companySlug);
    const { payload, page } = await this.request(
      "bank_accounts.list",
      "GET",
      `/companies/${slug}/bankAccounts`,
      {
        query: {
          ...pageQuery(input),
          ...(input.inactive !== undefined ? { inactive: String(input.inactive) } : {}),
        },
      },
    );
    return { companySlug: slug, bankAccounts: projectArray(payload), page };
  }

  async listPurchases(
    input: FikenListInput & {
      dateGe?: string | undefined;
      dateLe?: string | undefined;
      paid?: boolean | undefined;
    },
  ) {
    const slug = this.companySlugFor(input.companySlug);
    const { payload, page } = await this.request(
      "purchases.list",
      "GET",
      `/companies/${slug}/purchases`,
      {
        query: {
          ...pageQuery(input),
          ...(input.dateGe ? { dateGe: input.dateGe } : {}),
          ...(input.dateLe ? { dateLe: input.dateLe } : {}),
          ...(input.paid !== undefined ? { paid: String(input.paid) } : {}),
        },
      },
    );
    return { companySlug: slug, purchases: projectArray(payload), page };
  }

  async listSales(
    input: FikenListInput & {
      dateGe?: string | undefined;
      dateLe?: string | undefined;
      settled?: boolean | undefined;
    },
  ) {
    const slug = this.companySlugFor(input.companySlug);
    const { payload, page } = await this.request("sales.list", "GET", `/companies/${slug}/sales`, {
      query: {
        ...pageQuery(input),
        ...(input.dateGe ? { dateGe: input.dateGe } : {}),
        ...(input.dateLe ? { dateLe: input.dateLe } : {}),
        ...(input.settled !== undefined ? { settled: String(input.settled) } : {}),
      },
    });
    return { companySlug: slug, sales: projectArray(payload), page };
  }

  /**
   * The company scope for a call: an explicit slug wins, then the connection's
   * configured default, then the only verified company. Ambiguity is an error
   * that lists the available slugs instead of guessing.
   */
  private companySlugFor(requested: string | undefined): string {
    const slug =
      requested ??
      this.metadata.defaultCompanySlug ??
      (this.metadata.companies.length === 1 ? this.metadata.companies[0]!.slug : null);
    if (!slug) {
      throw new Error(
        `companySlug is required because this Fiken connection can access several companies: ${this.metadata.companies
          .map((company) => company.slug)
          .join(", ")}`,
      );
    }
    if (!COMPANY_SLUG_PATTERN.test(slug)) {
      throw new Error("companySlug must be a lowercase Fiken company slug");
    }
    return slug;
  }

  private async request(
    operation: FikenOperation,
    method: "GET" | "POST",
    path: string,
    input: { query?: Record<string, string>; body?: unknown },
  ): Promise<{ payload: unknown; page: FikenPage | null; locationId: number | null }> {
    try {
      const result = await serializedPerConnection(this.connection.id, async () => {
        const url = new URL(`${FIKEN_API_BASE}${path}`);
        for (const [key, value] of Object.entries(input.query ?? {})) {
          url.searchParams.set(key, value);
        }
        const headers = await this.headersFor(operation, url.toString());
        let response: Response;
        try {
          response = await this.fetchImpl(url, {
            method,
            headers: {
              ...headers,
              accept: "application/json",
              ...(input.body !== undefined ? { "content-type": "application/json" } : {}),
            },
            ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
            signal: AbortSignal.timeout(FIKEN_TIMEOUT_MS),
          });
        } catch {
          throw new FikenProviderError("transport_error");
        }
        return await this.readResponse(operation, response);
      });
      await this.recordAudit(operation, "succeeded");
      return result;
    } catch (error) {
      await this.recordAudit(operation, "failed", safeFailureCode(error));
      throw error;
    }
  }

  private async readResponse(
    operation: FikenOperation,
    response: Response,
  ): Promise<{ payload: unknown; page: FikenPage | null; locationId: number | null }> {
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      // Personal tokens have no refresh; the row needs a fresh pasted token.
      await setConnectionStatus(
        this.db,
        this.context.workspaceId,
        "needs_reauth",
        "Fiken rejected the API token",
        { id: this.connection.id, version: this.connection.version, subjectId: null },
      ).catch(() => undefined);
      throw new FikenProviderError("credential_rejected", 401);
    }
    if (response.status === 429) {
      await response.body?.cancel().catch(() => undefined);
      throw new FikenProviderError("rate_limited", 429);
    }
    if (!response.ok) {
      throw new FikenProviderError(
        `http_${response.status}`,
        response.status,
        await providerErrorMessage(response),
      );
    }
    const locationId = locationResourceId(response.headers.get("location"));
    if (response.status === 204 || response.headers.get("content-length") === "0") {
      await response.body?.cancel().catch(() => undefined);
      return { payload: null, page: null, locationId };
    }
    let payload: unknown = null;
    try {
      payload = await readResponseJsonBounded<unknown>(
        response,
        FIKEN_RESPONSE_MAX_BYTES,
        `Fiken ${operation} response`,
      );
    } catch (error) {
      // Creation endpoints answer 201 with a Location header and an empty
      // body; only a parse failure with no Location is a provider error.
      if (locationId === null) {
        throw new FikenProviderError("invalid_response", response.status, safeFailureCode(error));
      }
    }
    return { payload, page: pageFromHeaders(response.headers), locationId };
  }

  private async headersFor(
    operation: FikenOperation,
    destinationUrl: string,
  ): Promise<Record<string, string>> {
    const result = await this.resolveCredential({
      workspaceId: this.context.workspaceId,
      serverId: "opengeni-fiken",
      toolName: `fiken_${operation.replaceAll(".", "_")}`,
      connectionRef: {
        connectionId: this.connection.id,
        providerDomain: FIKEN_PROVIDER_DOMAIN,
        kind: this.connection.kind === "oauth2" ? "oauth2" : "api_key",
        subjectScope: "workspace",
      },
      destinationUrl,
    });
    if (result.status !== "ok" || result.connectionId !== this.connection.id) {
      throw new Error("the Fiken connection needs to be reconnected");
    }
    return result.headers;
  }

  private receipt(operation: FikenOperation, operationId?: string) {
    return {
      credentialRole: FIKEN_CREDENTIAL_ROLE,
      credentialLabel: FIKEN_CREDENTIAL_LABEL,
      connectionId: this.connection.id,
      operation,
      ...(operationId ? { operationId } : {}),
    };
  }

  private async recordAudit(
    operation: FikenOperation,
    outcome: "succeeded" | "failed",
    failureCode?: string,
  ): Promise<void> {
    await recordAuditEvent(this.db, {
      accountId: this.context.accountId,
      workspaceId: this.context.workspaceId,
      subjectId: this.context.subjectId,
      action: `fiken.${operation}`,
      targetType: "connection",
      targetId: this.connection.id,
      metadata: {
        ...this.receipt(operation),
        outcome,
        ...(failureCode ? { failureCode } : {}),
        ...(this.context.sessionId ? { sessionId: this.context.sessionId } : {}),
      },
    });
  }
}

export function createFikenClient(
  deps: { db: Database; settings: Settings; fikenFetch?: typeof fetch },
  resolved: Awaited<ReturnType<typeof resolveFikenConnectionForTool>>,
): FikenClient {
  return new FikenClient(
    deps.db,
    deps.settings,
    resolved.connection,
    resolved.metadata,
    resolved.context,
    deps.fikenFetch,
  );
}

function pageQuery(input: {
  page?: number | undefined;
  pageSize?: number | undefined;
}): Record<string, string> {
  return {
    page: String(boundedInt(input.page, Number.MAX_SAFE_INTEGER, 0)),
    pageSize: String(boundedInt(input.pageSize, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE)),
  };
}

function boundedInt(value: number | undefined, max: number, fallback: number): number {
  if (value === undefined || !Number.isInteger(value) || value < 0) return fallback;
  return Math.min(value, max);
}

function pageFromHeaders(headers: Headers): FikenPage | null {
  const page = headerInt(headers, "fiken-api-page");
  const pageSize = headerInt(headers, "fiken-api-page-size");
  if (page === null || pageSize === null) return null;
  return {
    page,
    pageSize,
    pageCount: headerInt(headers, "fiken-api-page-count"),
    resultCount: headerInt(headers, "fiken-api-result-count"),
  };
}

function headerInt(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : null;
}

/** The numeric resource id at the end of a Fiken `Location: .../{id}` header. */
function locationResourceId(location: string | null): number | null {
  if (!location) return null;
  const match = /\/(\d+)\/?$/.exec(location);
  if (!match) return null;
  const value = Number.parseInt(match[1]!, 10);
  return Number.isSafeInteger(value) ? value : null;
}

// Attachment and document blobs are large and useless to the agent surface;
// strip them from every projected provider record.
const STRIPPED_RECORD_FIELDS = new Set(["attachments", "documents"]);

function projectRecord(payload: unknown): Record<string, unknown> | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const projected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (STRIPPED_RECORD_FIELDS.has(key)) continue;
    projected[key] = value;
  }
  return projected;
}

function projectArray(payload: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(payload)) return [];
  return payload
    .map(projectRecord)
    .filter((record): record is Record<string, unknown> => record !== null);
}

async function providerErrorMessage(response: Response): Promise<string | null> {
  try {
    const payload = await readResponseJsonBounded<unknown>(
      response,
      FIKEN_ERROR_BODY_MAX_BYTES,
      "Fiken error response",
    );
    if (typeof payload !== "object" || payload === null) return null;
    const record = payload as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of ["message", "error", "error_description"]) {
      if (typeof record[key] === "string") parts.push(record[key] as string);
    }
    if (Array.isArray(record.validationMessages)) {
      for (const entry of record.validationMessages) {
        if (typeof entry === "string") parts.push(entry);
      }
    }
    const joined = parts.join("; ");
    return joined ? joined.slice(0, FIKEN_PROVIDER_MESSAGE_MAX_CHARS) : null;
  } catch {
    return null;
  }
}

function safeFailureCode(error: unknown): string {
  if (error instanceof FikenProviderError) return error.code;
  return "unexpected_error";
}

// --- OAuth (registered Fiken app) -----------------------------------------------------------
//
// Fiken's authorization-code flow: no PKCE and no scopes, `state` required, a
// Basic-authenticated token endpoint, ~24h access tokens, and a refresh token
// that may rotate on every refresh. The stored bundle carries the token
// endpoint plus client credentials in `client_secret_basic` shape so the
// generic connection broker owns all later refreshes.

const FIKEN_AUTHORIZE_URL = "https://fiken.no/oauth/authorize";
const FIKEN_TOKEN_URL = "https://fiken.no/oauth/token";
const FIKEN_OAUTH_MAX_RESPONSE_BYTES = 256 * 1024;

export class FikenOAuthCallbackError extends Error {
  constructor(readonly reason: string) {
    super(`Fiken OAuth callback failed: ${reason}`);
    this.name = "FikenOAuthCallbackError";
  }
}

type FikenOAuthState = {
  accountId: string;
  workspaceId: string;
  subjectId: string;
  returnPath: string;
  connectionId?: string;
  connectionVersion?: number;
  nonce: string;
  iat: number;
};

function requireFikenOAuthSettings(settings: Settings): {
  clientId: string;
  clientSecret: string;
} {
  const clientId = settings.fikenClientId?.trim();
  const clientSecret = settings.fikenClientSecret?.trim();
  if (!clientId || !clientSecret) {
    throw new HTTPException(503, {
      message:
        "Fiken OAuth requires OPENGENI_FIKEN_OAUTH_CLIENT_ID and OPENGENI_FIKEN_OAUTH_CLIENT_SECRET",
    });
  }
  return { clientId, clientSecret };
}

export async function startFikenOAuth(
  deps: ApiRouteDeps,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
    requestUrl: string;
    payload: FikenOAuthStartRequest;
  },
): Promise<FikenOAuthStartResponse> {
  const fiken = requireFikenOAuthSettings(deps.settings);
  requireIntegrationsStateSecret(deps.settings);
  const existing = input.payload.connectionId
    ? await getConnectionMetadata(deps.db, input.workspaceId, input.payload.connectionId, null)
    : null;
  if (input.payload.connectionId && !existing) {
    throw new HTTPException(404, { message: "connection not found" });
  }
  if (existing && !isFikenConnection(existing)) {
    throw new HTTPException(422, { message: "connectionId is not a Fiken connection" });
  }
  const baseUrl = integrationBaseUrl(deps.settings.publicBaseUrl, input.requestUrl);
  const state = createSignedState(requireIntegrationsStateSecret(deps.settings), {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    subjectId: input.subjectId,
    returnPath: `/workspaces/${input.workspaceId}/capabilities`,
    ...(existing ? { connectionId: existing.id, connectionVersion: existing.version } : {}),
  });
  const authorizationUrl = new URL(FIKEN_AUTHORIZE_URL);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", fiken.clientId);
  authorizationUrl.searchParams.set("redirect_uri", `${baseUrl}/v1/integrations/fiken/callback`);
  authorizationUrl.searchParams.set("state", state);
  return FikenOAuthStartResponse.parse({
    authorizationUrl: authorizationUrl.toString(),
    expiresAt: new Date(Date.now() + oauthStateTtlMs).toISOString(),
  });
}

export async function completeFikenOAuthCallback(
  deps: ApiRouteDeps,
  input: {
    code?: string | undefined;
    state?: string | undefined;
    error?: string | undefined;
    requestUrl: string;
  },
): Promise<{ redirectTo: string }> {
  const baseUrl = integrationBaseUrl(deps.settings.publicBaseUrl, input.requestUrl);
  const returnBaseUrl = deps.settings.webBaseUrl?.replace(/\/+$/, "") ?? baseUrl;
  let state: FikenOAuthState | null = null;
  try {
    state = readFikenOAuthState(input.state, deps.settings);
    await requireFikenCallbackGrant(deps.db, state);
    const consumed = await consumeIntegrationOAuthStateNonce(deps.db, {
      accountId: state.accountId,
      workspaceId: state.workspaceId,
      subjectId: state.subjectId,
      nonce: state.nonce,
      expiresAt: new Date(state.iat * 1000 + oauthStateTtlMs),
      now: new Date(),
    });
    if (!consumed) {
      throw new FikenOAuthCallbackError("state_replayed");
    }
    if (input.error) {
      throw new FikenOAuthCallbackError(
        input.error === "access_denied" ? "provider_denied" : "provider_error",
      );
    }
    if (!input.code) {
      throw new FikenOAuthCallbackError("missing_code");
    }
    const fiken = requireFikenOAuthSettings(deps.settings);
    const key = requireEnvironmentEncryption(deps.settings);
    const fetchImpl = deps.fikenFetch ?? fetch;
    const token = await exchangeFikenAuthorizationCode(
      {
        code: input.code,
        clientId: fiken.clientId,
        clientSecret: fiken.clientSecret,
        redirectUri: `${baseUrl}/v1/integrations/fiken/callback`,
        state: input.state!,
      },
      fetchImpl,
    );
    const companies = await fetchFikenCompanies(token.accessToken, fetchImpl);
    if (companies.outcome !== "ok") {
      throw new FikenOAuthCallbackError(
        companies.outcome === "no_companies" ? "no_api_company" : "company_discovery_failed",
      );
    }
    // Re-check authorization after the slow provider round-trips.
    await requireFikenCallbackGrant(deps.db, state);
    const existing = state.connectionId
      ? await getConnectionMetadata(deps.db, state.workspaceId, state.connectionId, null)
      : null;
    if (state.connectionId && (!existing || !isFikenConnection(existing))) {
      throw new FikenOAuthCallbackError("connection_conflict");
    }
    if (existing && existing.version !== state.connectionVersion) {
      throw new FikenOAuthCallbackError("connection_conflict");
    }
    const previousMetadata = existing ? fikenConnectionMetadata(existing.metadata) : null;
    const previousDefault = previousMetadata?.defaultCompanySlug ?? null;
    const defaultCompanySlug =
      previousDefault && companies.companies.some((company) => company.slug === previousDefault)
        ? previousDefault
        : companies.companies.length === 1
          ? companies.companies[0]!.slug
          : null;
    const credentialEncrypted = encryptEnvironmentValue(
      key,
      JSON.stringify({
        access_token: token.accessToken,
        refresh_token: token.refreshToken,
        token_type: token.tokenType,
        ...(token.expiresAt ? { expires_at: token.expiresAt.toISOString() } : {}),
        token_endpoint: FIKEN_TOKEN_URL,
        client_id: fiken.clientId,
        client_secret: fiken.clientSecret,
        token_endpoint_auth_method: "client_secret_basic",
      }),
    );
    const metadata = {
      credentialRole: FIKEN_CREDENTIAL_ROLE,
      credentialLabel: FIKEN_CREDENTIAL_LABEL,
      companies: companies.companies,
      defaultCompanySlug,
      verifiedAt: new Date().toISOString(),
    };
    const connection = existing
      ? await updateConnection(deps.db, {
          workspaceId: state.workspaceId,
          connectionId: existing.id,
          visibleToSubjectId: null,
          expectedVersion: existing.version,
          kind: "oauth2",
          status: "active",
          credentialEncrypted,
          expiresAt: token.expiresAt,
          metadata,
          updatedBySubjectId: state.subjectId,
        })
      : await createConnection(deps.db, {
          accountId: state.accountId,
          workspaceId: state.workspaceId,
          // Workspace-owned by design, like the pasted-token install: the
          // first-party fiken tools resolve only workspace connections until
          // the delegation-snapshot lane exists for personal ownership.
          subjectId: null,
          providerDomain: FIKEN_PROVIDER_DOMAIN,
          kind: "oauth2",
          credentialEncrypted,
          grantedScopes: [],
          expiresAt: token.expiresAt,
          metadata,
          createdBySubjectId: state.subjectId,
        });
    if (!connection) {
      throw new FikenOAuthCallbackError("connection_conflict");
    }
    return {
      redirectTo: fikenReturnUrl(returnBaseUrl, state.returnPath, "connected", connection.id),
    };
  } catch (error) {
    return {
      redirectTo: fikenReturnUrl(
        returnBaseUrl,
        state?.returnPath ?? "/integrations",
        "error",
        error instanceof FikenOAuthCallbackError ? error.reason : "callback_failed",
      ),
    };
  }
}

async function exchangeFikenAuthorizationCode(
  input: {
    code: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    state: string;
  },
  fetchImpl: FetchLike,
): Promise<{
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresAt: Date | null;
}> {
  let response: Response;
  try {
    response = await fetchImpl(FIKEN_TOKEN_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: input.redirectUri,
        state: input.state,
      }),
      signal: AbortSignal.timeout(FIKEN_TIMEOUT_MS),
    });
  } catch {
    throw new FikenOAuthCallbackError("token_exchange_unreachable");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new FikenOAuthCallbackError("token_exchange_failed");
  }
  let payload: Record<string, unknown>;
  try {
    payload = await readResponseJsonBounded<Record<string, unknown>>(
      response,
      FIKEN_OAUTH_MAX_RESPONSE_BYTES,
      "Fiken OAuth token response",
    );
  } catch {
    throw new FikenOAuthCallbackError("token_exchange_failed");
  }
  const accessToken = typeof payload.access_token === "string" ? payload.access_token : null;
  const refreshToken = typeof payload.refresh_token === "string" ? payload.refresh_token : null;
  if (!accessToken || !refreshToken) {
    throw new FikenOAuthCallbackError("token_exchange_failed");
  }
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : null;
  return {
    accessToken,
    refreshToken,
    tokenType: typeof payload.token_type === "string" ? payload.token_type : "Bearer",
    expiresAt:
      expiresIn && Number.isFinite(expiresIn) ? new Date(Date.now() + expiresIn * 1000) : null,
  };
}

function readFikenOAuthState(raw: string | undefined, settings: Settings): FikenOAuthState {
  if (!raw) {
    throw new FikenOAuthCallbackError("missing_state");
  }
  const payload = readSignedState(raw, requireIntegrationsStateSecret(settings)) as Record<
    string,
    unknown
  > | null;
  if (!payload) {
    throw new FikenOAuthCallbackError("invalid_state");
  }
  const iat = typeof payload.iat === "number" ? payload.iat : undefined;
  const now = Math.floor(Date.now() / 1000);
  if (iat === undefined || now < iat || now - iat > oauthStateTtlMs / 1000) {
    throw new FikenOAuthCallbackError("invalid_state");
  }
  const required = (value: unknown): string => {
    if (typeof value !== "string" || value.length === 0) {
      throw new FikenOAuthCallbackError("invalid_state");
    }
    return value;
  };
  return {
    accountId: required(payload.accountId),
    workspaceId: required(payload.workspaceId),
    subjectId: required(payload.subjectId),
    returnPath: required(payload.returnPath),
    ...(typeof payload.connectionId === "string" ? { connectionId: payload.connectionId } : {}),
    ...(typeof payload.connectionVersion === "number"
      ? { connectionVersion: payload.connectionVersion }
      : {}),
    nonce: required(payload.nonce),
    iat,
  };
}

async function requireFikenCallbackGrant(db: Database, state: FikenOAuthState): Promise<void> {
  const grant = await getWorkspaceGrant(db, state.subjectId, state.workspaceId);
  if (
    !grant ||
    grant.accountId !== state.accountId ||
    !hasPermission(grant.permissions, "connections:write")
  ) {
    throw new FikenOAuthCallbackError("permission_lost");
  }
}

function fikenReturnUrl(
  returnBaseUrl: string,
  returnPath: string,
  status: "connected" | "error",
  value: string,
): string {
  const url = new URL(returnPath, returnBaseUrl);
  url.searchParams.set("fiken", status);
  url.searchParams.set(status === "connected" ? "connectionId" : "reason", value);
  return url.toString();
}
