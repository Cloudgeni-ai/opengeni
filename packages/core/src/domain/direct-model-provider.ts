import {
  azureOpenAIDeploymentIdentityAvailable,
  deploymentAzureEntraCredential,
  type AzureEntraProviderCredential,
  type Settings,
} from "@opengeni/config";
import { DirectModelProviderMetadata } from "@opengeni/contracts";
import {
  AzureEntraTokenError,
  createAzureEntraAccessTokenSource,
} from "@opengeni/network/azure-entra";
import { HTTPException } from "hono/http-exception";

/**
 * How a setup check signs in: a provider key, or (Azure OpenAI only) a
 * Microsoft Entra ID access token.
 */
export type DirectModelAccessCredential = string | { bearerToken: string };

/** Verify the customer's exact route without persisting their key or test response. */
export async function verifyDirectModelAccess(
  input: DirectModelProviderMetadata,
  credential: DirectModelAccessCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const config = DirectModelProviderMetadata.parse(input);
  const baseUrl = config.provider === "openai" ? "https://api.openai.com/v1" : config.endpoint!;
  const bearer = typeof credential === "string" ? null : credential.bearerToken;
  if (bearer !== null && config.provider !== "azure_openai")
    throw new Error("only Azure OpenAI is checked with a Microsoft Entra ID token");
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/responses`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "content-type": "application/json",
        ...(bearer !== null
          ? { authorization: `Bearer ${bearer}` }
          : config.provider === "openai"
            ? { authorization: `Bearer ${credential as string}` }
            : { "api-key": credential as string }),
      },
      body: JSON.stringify({
        model: config.model,
        input: "Reply OK.",
        max_output_tokens: 32,
        store: false,
      }),
    });
  } catch {
    throw new HTTPException(502, {
      message: "We couldn’t reach your model provider. Check the endpoint and try again.",
    });
  }
  // Never reflect provider responses: they can include credentials or request details.
  if (response.status === 401 || response.status === 403) {
    throw new HTTPException(422, {
      message:
        bearer !== null
          ? "Azure didn’t let this identity use the resource. Give it the Cognitive Services OpenAI User role on the Azure OpenAI resource, then try again."
          : "Your provider didn’t accept this API key. Check the key and its permissions.",
    });
  }
  if (response.status === 404 || response.status === 400) {
    throw new HTTPException(422, {
      message:
        config.provider === "azure_openai"
          ? "Azure couldn’t use this deployment. Check the endpoint and deployment name."
          : "OpenAI couldn’t use this model. Check the model name and your account’s access.",
    });
  }
  if (response.status === 429) {
    throw new HTTPException(422, {
      message:
        "Your provider’s quota or rate limit blocked the check. Check your provider billing or try again shortly.",
    });
  }
  const body = response.ok ? await response.json().catch(() => null) : null;
  if (!body || !["completed", "incomplete"].includes(body.status)) {
    throw new HTTPException(502, {
      message: "Your provider couldn’t complete the connection check. Try again shortly.",
    });
  }
}

/**
 * Check that an organization OpenAI model or Azure OpenAI deployment answers
 * with the organization's own key (and Azure endpoint) before it is saved as a
 * curated model. Same short Responses call and safe errors as the workspace
 * direct-connection setup check; nothing upstream is reflected or persisted.
 */
export async function verifyOrganizationDirectModel(
  input:
    | { provider: "openai"; model: string }
    | { provider: "azure_openai"; model: string; endpoint: string },
  credential: DirectModelAccessCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const config = DirectModelProviderMetadata.safeParse(input);
  if (!config.success) {
    throw new HTTPException(422, {
      message:
        input.provider === "openai"
          ? "Enter the exact OpenAI model ID."
          : "Enter the exact Azure OpenAI deployment name.",
    });
  }
  await verifyDirectModelAccess(config.data, credential, fetchImpl);
}

/** The organization Azure OpenAI form of {@link verifyOrganizationDirectModel}. */
export async function verifyOrganizationAzureOpenAIDeployment(
  input: { endpoint: string; deployment: string },
  credential: DirectModelAccessCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await verifyOrganizationDirectModel(
    { provider: "azure_openai", model: input.deployment, endpoint: input.endpoint },
    credential,
    fetchImpl,
  );
}

/**
 * Sign in once as an organization Azure OpenAI connection's Microsoft Entra
 * identity, for a setup check: the organization's own app, or the
 * deployment's identity only while the operator offers it. Errors are safe
 * to show an admin; Entra's own description is never reflected.
 */
export async function organizationAzureEntraSetupToken(
  settings: Settings,
  credential: AzureEntraProviderCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<{ bearerToken: string }> {
  const identity =
    credential.source === "client_secret"
      ? {
          tenantId: credential.tenantId,
          clientId: credential.clientId,
          clientSecret: credential.clientSecret,
        }
      : azureOpenAIDeploymentIdentityAvailable(settings)
        ? deploymentAzureEntraCredential(settings)
        : null;
  if (!identity)
    throw new HTTPException(422, {
      message: "This deployment doesn’t offer its own identity for Azure OpenAI.",
    });
  try {
    const token = await createAzureEntraAccessTokenSource(identity, {
      fetch: (url, init) => fetchImpl(url, init),
    })();
    return { bearerToken: token };
  } catch (error) {
    if (error instanceof AzureEntraTokenError && error.reason === "rejected")
      throw new HTTPException(422, {
        message:
          credential.source === "client_secret"
            ? "Microsoft Entra ID didn’t accept this app. Check the directory (tenant) ID, application (client) ID and client secret."
            : "Microsoft Entra ID didn’t accept this deployment’s identity. Ask the deployment operator to check its configuration.",
      });
    throw new HTTPException(502, {
      message: "We couldn’t reach Microsoft Entra ID. Try again shortly.",
    });
  }
}
