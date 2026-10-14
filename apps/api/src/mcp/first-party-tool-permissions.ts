/**
 * The per-tool registration predicate lives in `@opengeni/contracts` so the
 * worker can read the same data; this module keeps the API's import path.
 */
export {
  FIRST_PARTY_TOOL_AUTHORIZATION,
  permissionsRequiredByFirstPartyTools,
  type FirstPartyToolAuthorization,
} from "@opengeni/contracts";
