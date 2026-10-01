/* URL state for Settings > API keys:
     ?section=api-keys                 the list
     ?section=api-keys&key=new         Create API key (a form page)
     ?section=api-keys&key=<key id>    a key's page */

export const NEW_API_KEY = "new";

const KEY_ID = /^[\w-]{1,128}$/;

export function parseApiKeyParam(value: unknown): string | undefined {
  return typeof value === "string" && KEY_ID.test(value) ? value : undefined;
}
