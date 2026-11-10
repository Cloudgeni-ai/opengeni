/* ----------------------------------------------------------------------------
   Azure shows the same resource under several addresses: the Azure OpenAI
   endpoint (https://NAME.openai.azure.com), the Cognitive Services and
   Microsoft Foundry endpoints of the same resource, and a deployment's
   Target URI, which also names the deployment. People paste whichever one
   they found. This reads any of them as the resource's Azure OpenAI endpoint,
   and the deployment when the address names one, so connecting Azure needs
   no knowledge of which address is the right one.
   -------------------------------------------------------------------------- */

const AZURE_RESOURCE_HOST =
  /^([a-z0-9][a-z0-9-]*)\.(?:openai\.azure\.com|cognitiveservices\.azure\.com|services\.ai\.azure\.com)$/i;

export type AzureOpenAIAddress = {
  /** The resource's Azure OpenAI endpoint: https://NAME.openai.azure.com. */
  endpoint: string;
  /** The deployment a Target URI names, when it names one. */
  deployment?: string | undefined;
};

/** The resource (and deployment) an address from Azure points at, or null if it isn't one. */
export function readAzureOpenAIAddress(value: string): AzureOpenAIAddress | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const resource = AZURE_RESOURCE_HOST.exec(url.hostname)?.[1];
  if (!resource) return null;
  const named = /^\/openai\/deployments\/([^/]+)/i.exec(url.pathname)?.[1];
  let deployment: string | undefined;
  try {
    deployment = named ? decodeURIComponent(named) : undefined;
  } catch {
    deployment = undefined;
  }
  return {
    endpoint: `https://${resource.toLowerCase()}.openai.azure.com`,
    ...(deployment ? { deployment } : {}),
  };
}
