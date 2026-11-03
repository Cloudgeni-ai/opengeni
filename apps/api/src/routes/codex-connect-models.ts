import { fetchCodexModels, CODEX_CLIENT_VERSION, type CodexFetch } from "@opengeni/codex";
import {
  configuredModels,
  productLabelForModelId,
  withCodexCatalogProvider,
  type Settings,
} from "@opengeni/config";

/** A Codex model the just-connected account offers, as Opengeni names it. */
export type CodexConnectOfferedModel = { id: string; label: string };

/**
 * Which of Opengeni's Codex models a just-connected ChatGPT account offers,
 * read once from its live /models list with the tokens the sign-in returned
 * (nothing is stored). A Free plan offers GPT-6 Luna only; an account that
 * offers none of them is told so at connect time instead of at Send.
 *
 * The list is taken as the backend returns it for this client version: the
 * Codex CLI shows every listed model to ChatGPT sign-ins (`supported_in_api`
 * only filters API-key sign-ins) and the backend applies
 * `minimal_client_version` itself from the `client_version` query.
 *
 * Null when the read fails: the connection still succeeded.
 */
export async function codexConnectOfferedModels(input: {
  settings: Settings;
  accessToken: string;
  chatgptAccountId: string | null;
  isFedramp: boolean;
  fetchImpl?: CodexFetch | undefined;
}): Promise<CodexConnectOfferedModel[] | null> {
  try {
    const read = await fetchCodexModels(
      {
        accessToken: input.accessToken,
        chatgptAccountId: input.chatgptAccountId,
        isFedramp: input.isFedramp,
        clientVersion: CODEX_CLIENT_VERSION,
      },
      input.fetchImpl,
    );
    if (!read.ok) return null;
    const offered = new Set(read.slugs);
    return configuredModels(withCodexCatalogProvider(input.settings))
      .filter(
        (model) =>
          model.credentialSource.kind === "connected_subscription" &&
          model.credentialSource.provider === "codex" &&
          offered.has(model.upstreamModelId),
      )
      .map((model) => ({ id: model.id, label: productLabelForModelId(model.id) }));
  } catch {
    return null;
  }
}
