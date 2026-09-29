/**
 * Content-free per-person product lifecycle facts.
 *
 * Migration `0532_product_lifecycle_fact_export.sql` captures one fact per
 * product change with row triggers and writes it to the durable host export as
 * the `lifecycle_fact` kind. Every value is drawn from a fixed list; the
 * database function `opengeni_private.product_lifecycle_fact_valid` enforces
 * the same lists and a test keeps the two copies identical.
 */

/** Each fact type and the fixed values its `attribute` may carry. */
export const PRODUCT_LIFECYCLE_FACT_ATTRIBUTES = {
  /** A managed account was created. Attribute: first sign-in method. */
  "auth.sign_up": ["email", "google", "github", "other"],
  /**
   * The account email became verified: by the verification link, or at
   * creation when a social provider already verified it.
   */
  "auth.email_verified": [],
  /** A live sign-in session was created. Attribute: method of that session. */
  "auth.sign_in": ["email", "google", "github", "other"],
  /** An organization was created by self-service setup or as an additional one. */
  "organization.setup": ["created", "additional"],
  /** A model subscription or organization model provider was connected. */
  "model.connected": ["codex", "supergrok", "vercel_gateway", "openrouter"],
  /** A credit top-up payment was granted. */
  "credits.purchased": [],
  /** An integration connection was created. Attribute: provider class. */
  "connection.created": [
    "slack",
    "github",
    "gitlab",
    "azure_devops",
    "bitbucket",
    "google",
    "microsoft",
    "linear",
    "atlassian",
    "notion",
    "supabase",
    "datadog",
    "posthog",
    "openai",
    "x",
    "other",
  ],
  "scheduled_task.created": [],
  /** A catalog Skill was installed into a workspace. */
  "skill.installed": [],
  /** A Slack user was linked to an OpenGeni user. */
  "slack.user_linked": [],
  /** A new Connected Machine was enrolled. */
  "machine.enrolled": [],
  /** A person became an active member of an organization that already had one. */
  "member.joined": [],
} as const satisfies Record<string, readonly string[]>;

export type ProductLifecycleFactType = keyof typeof PRODUCT_LIFECYCLE_FACT_ATTRIBUTES;

export const PRODUCT_LIFECYCLE_FACT_TYPES = Object.keys(
  PRODUCT_LIFECYCLE_FACT_ATTRIBUTES,
) as ProductLifecycleFactType[];

/**
 * What kind of subject caused the fact. Only `user` and `api_key` facts carry
 * their opaque subject id; every other subject string is reduced to its kind
 * because embedded hosts may put their own identifiers in it.
 */
export const PRODUCT_LIFECYCLE_SUBJECT_KINDS = [
  "user",
  "api_key",
  "service",
  "other",
  "none",
] as const;
export type ProductLifecycleSubjectKind = (typeof PRODUCT_LIFECYCLE_SUBJECT_KINDS)[number];

/** Pseudonymous subject ids that may leave the database. */
export const PRODUCT_LIFECYCLE_SUBJECT_ID_PATTERN = /^(user|api_key):[A-Za-z0-9_-]{8,128}$/;

export function isProductLifecycleFact(type: string, attribute: string | null): boolean {
  if (!Object.hasOwn(PRODUCT_LIFECYCLE_FACT_ATTRIBUTES, type)) return false;
  const allowed: readonly string[] =
    PRODUCT_LIFECYCLE_FACT_ATTRIBUTES[type as ProductLifecycleFactType];
  return allowed.length === 0
    ? attribute === null
    : attribute !== null && allowed.includes(attribute);
}
