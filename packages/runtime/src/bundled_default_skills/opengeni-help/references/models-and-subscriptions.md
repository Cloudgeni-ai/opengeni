# Models and subscription settings

Use this reference to explain model and subscription settings in the words the
person sees, and to change them for the person when your session has the
authority to do so. Recheck labels against the deployed interface when exact
wording matters.

## Where the settings live

- Organization settings, Models: subscription accounts the organization
  connects (Codex, Claude, SuperGrok), API-key model providers, and the
  organization's default for Context & compaction.
- Workspace settings, Models: which models this workspace offers, which
  subscription accounts it uses, its Codex options, and its own Context &
  compaction override.
- A personal workspace can also hold accounts that only its owner uses.

What pays for a model: an API-key provider bills that provider account per
request. A subscription account (Codex, Claude, SuperGrok) uses the plan of the
person who signed in, within that plan's usage limits. Opengeni credits are a
separate charge; zero Opengeni charge does not mean zero provider cost.

## Organization subscription account settings

Each organization subscription account has its own page.

- Which workspaces can use it: All workspaces, All workspaces + Personal, Only
  selected workspaces, Personal workspaces only, or No workspaces. An account
  set to No workspaces is connected but serves nothing; point this out when
  someone asks why an account is unused.
- Models it can serve: "All models, including new ones" also covers models the
  provider adds later. "Only the models I choose" keeps new models off until
  someone adds them.
- Use for new work: when off, the account is not picked for new chats or
  schedules. Work already running continues. Use this to retire an account
  gently.
- Use extra credits: allows paid extra credits after the plan's included usage
  runs out. Spread work uses other accounts' included usage first. Usage updates
  can lag, so a request may still use credits shortly after this is turned off.
- Usage: the page shows remaining usage and when it resets. When every eligible
  account is exhausted, new work waits for capacity and continues by itself when
  usage returns; it is not failed.
- Usage limit resets: a plan may offer resets that give the account a fresh
  5-hour and weekly limit. The account's row shows how many are waiting, and
  its page lists them under Usage limit resets with their expiry. Redeeming is
  irreversible and done by a person in their own browser: an organization
  account by an organization owner or admin, from Organization settings >
  Models > the account's page, even when no workspace uses it; a workspace's
  own account by the person who connected it, from that workspace's Models
  page. An agent can read how many are available and when they expire, and
  explain what one does, but cannot redeem it; send the person to that page.
- Disconnect: workspaces stop using the account for new work, work already
  running finishes first, and reconnecting needs a new sign-in. Confirm with the
  person before disconnecting.

## Workspace Codex options

- Which accounts: a workspace uses either its own Codex accounts or the
  organization's, never both for new work. Codex can also be turned off for the
  workspace; accounts stay connected.
- Sharing work between this workspace's accounts: Spread work sends each new
  chat to the account with the most usage left. Primary only uses the primary
  account and waits when it runs out.
- Keep Codex chats portable: summarizes long chats in a form another provider's
  model can continue. Off keeps new chats on Codex, with better memory of long
  conversations.
- Codex Apps: lets agents use the ChatGPT apps connected to one account. It must
  be an account owned by the workspace.

## Context & compaction

Controls when long chats are summarized to fit the model's context. The
organization sets a default and a workspace can override it. A change applies to
later turns; it does not interrupt a reply that is already running.

## Acting as an agent

When your session has organization admin access, use the admin action tools:

1. Find the action with `admin_actions_search`, then read it with
   `admin_action_describe`. Each action has a plain description.
2. Read the current settings before writing. Send the version or revision that
   read returned, so a concurrent change is not overwritten.
3. Call it with `admin_action_call`, then read the setting back to confirm.

Connecting accounts:

- Codex and SuperGrok use device sign-in. Start it with the account's connect
  start action, give the person the code and the link, and poll the matching
  action until it reports connected or expired. The person signs in with their
  own provider account; never ask for a password.
- Claude sign-in is tied to the person's browser. Send them to the Claude
  account page, or use a setup token they create and paste in themselves.

Describe changes in the interface's words, for example "Which workspaces can use
it is now All workspaces", not internal field names. If an action is refused,
report the reason and what the person can do rather than retrying the same call.
