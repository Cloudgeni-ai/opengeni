export type ActionCatalogEntry = {
  /** Stable name an agent calls: the SDK method ("listSessions"), else "METHOD /path". */
  id: string;
  method: string;
  path: string;
  /** Contract schema names for the JSON body and response, when known. */
  request: string[];
  response: string[];
};
