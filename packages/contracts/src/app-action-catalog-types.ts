export type ActionCatalogEntry = {
  /** Stable name an agent calls: the SDK method ("listSessions"), else "METHOD /path". */
  id: string;
  method: string;
  path: string;
  /** Contract schema names for the JSON body and response, when known. */
  request: string[];
  /**
   * Query parameter names the route reads, from its handler. Set only when it
   * reads any; describe lists them so a caller can filter and page.
   */
  query?: string[];
  response: string[];
  /**
   * Why no MCP caller can complete this action: it needs the person's own
   * Opengeni browser session. Set only on such actions; the server hides them.
   */
  browserOnly?: string;
  /**
   * The route that replaced this removed one ("METHOD /path"), which now only
   * answers 410 `gone`. Set only on such actions; the server hides them from
   * search, points describe and call at the replacement, and treats them as
   * running nothing (no confirmation is asked for them).
   */
  retired?: string;
  /**
   * Where the action carries a key, password, token or other secret: field
   * paths ("request.apiKey", "response.token") or a route reason, derived by
   * the catalog generator. Without full access a chat leaves it to the app.
   */
  secretFields?: string[];
};
