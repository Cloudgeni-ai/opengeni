export type ActionCatalogEntry = {
  /** Stable name an agent calls, from the SDK method ("listSessions"). */
  id: string;
  method: string;
  path: string;
  /** Contract schema names for the JSON body and response, when known. */
  request: string[];
  response: string[];
};
