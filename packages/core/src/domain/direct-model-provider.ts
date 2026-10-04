import { DirectModelProviderMetadata } from "@opengeni/contracts";
import { HTTPException } from "hono/http-exception";

/** Verify the customer's exact route without persisting their key or test response. */
export async function verifyDirectModelAccess(
  input: DirectModelProviderMetadata,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const config = DirectModelProviderMetadata.parse(input);
  const baseUrl = config.provider === "openai" ? "https://api.openai.com/v1" : config.endpoint!;
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/responses`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "content-type": "application/json",
        ...(config.provider === "openai"
          ? { authorization: `Bearer ${apiKey}` }
          : { "api-key": apiKey }),
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
      message: "Your provider didn’t accept this API key. Check the key and its permissions.",
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
