/**
 * Integration Knowledge sync was removed: integrations give agents tools, and
 * recurring work is an ordinary agent schedule that uses them. Public request
 * shapes and routes from that feature stay until the next SDK major and
 * answer 410 with this message.
 */
export const KNOWLEDGE_SOURCE_SYNC_RETIRED_MESSAGE =
  "Integration Knowledge sync has been removed. Integrations give agents tools; create an ordinary agent schedule that uses them for recurring work.";
