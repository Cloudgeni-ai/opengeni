/**
 * Creating a Slack agent from Slack.
 *
 * A chat started from Slack proposes an agent with `slack_agent_propose`. The
 * server posts a confirmation card in that chat's own Slack thread and stores
 * the proposal. A click on Create is checked against the stored proposal (the
 * button carries only its id), and only someone whose linked Opengeni identity
 * is currently `workspace:admin` in the target workspace can confirm; anyone
 * else gets a private reply. Creating goes through the same function as the
 * admin API, and clicks are idempotent: the agent's id is the proposal's id.
 *
 * Nothing here changes routing or any other Slack post. The tool exists only in
 * Slack-started chats with workspace routing on.
 */
import {
  CreateSlackAgentRequest,
  slackAgentNameKey,
  type AccessGrant,
  type SessionAvatar,
} from "@opengeni/contracts";
import {
  getSlackAgentProposal,
  getSlackBotPostOperation,
  getSlackBotUserLink,
  getSlackInteractionForSession,
  getWorkspace,
  insertSlackAgentProposal,
  listNamedSubjectSlackRoutableWorkspaces,
  resolveSlackInstallationRoute,
  resolveSlackTargetAuthority,
  setSlackAgentProposalMessage,
  transitionSlackAgentProposal,
  type KnowledgeContext,
  type SlackAgentProposal,
  type SlackInteractionInboxEntry,
} from "@opengeni/db";
import { hasPermission, type ApiRouteDeps } from "@opengeni/core";
import { HTTPException } from "hono/http-exception";

import { requireUsableSessionAvatar } from "../routes/session-avatar";
import { createSlackAgent, slackAgentDeterministicUuid } from "./slack-agent-create";
import { loadSlackAgentsForConnection, slackAgentCallText } from "./slack-agents";
import { escapeSlackMrkdwn } from "./slack-app-home";
import { createOpenGeniSlackBotInteractionClient, type SlackMessageBlock } from "./slack-bot";
import { sessionAvatarImageUrl } from "./session-avatar-image";

export const SLACK_AGENT_PROPOSAL_CREATE_ACTION_ID = "opengeni.agent_proposal.create";
export const SLACK_AGENT_PROPOSAL_CANCEL_ACTION_ID = "opengeni.agent_proposal.cancel";

const SLACK_PROPOSAL_BOT_SUBJECT_ID = "service:slack-interaction";
const CARD_INSTRUCTIONS_MAX_CHARS = 2_500;

/** What the chat is told about `slack_agent_propose`, including how to get an icon. */
export const SLACK_AGENT_PROPOSE_TOOL_DESCRIPTION = [
  'Propose a new Slack agent when someone in Slack asks to create one: a named teammate people call with "@Opengeni +name" that always works in one shared workspace and has its own Memory.',
  "This posts a card in this chat's own Slack thread showing the name, icon, description, workspace and instructions, with Create and Cancel. Nothing is created until a current admin of that workspace presses Create, so never say it was created.",
  "name: what people type after +; letters, numbers, spaces and hyphens. description: one line about what it does. instructions: how it should work, written to the agent, at most 2500 characters. workspace: the shared workspace it works in, by name; omit it for this chat's workspace.",
  'An icon is required. If you have an image-generation tool, generate one (a flat icon filling the whole square: one bold symbol for its job on a solid, strong colour, with no frame, faces, fine detail or text), publish it to the workspace, and pass {kind:"image",artifactId}; the image must be in the agent\'s workspace. Otherwise ask the person which emoji to use and pass {kind:"emoji",emoji,hue} with hue 0-359; {kind:"icon",icon,hue} also works.',
  "Ask for anything missing before calling. After status proposed, tell the person in one short sentence that an admin of the workspace can press Create.",
].join(" ");

export type SlackAgentProposalInput = {
  name: string;
  description: string;
  instructions?: string | undefined;
  /** A workspace name or id; the chat's own workspace when omitted. */
  workspace?: string | undefined;
  avatar: SessionAvatar;
};

export type SlackAgentProposalResult =
  | { status: "proposed"; proposalId: string; message: string }
  | { status: "refused"; message: string };

/** What a card shows, read from the stored proposal. */
export type SlackAgentProposalCardView = {
  proposalId: string;
  name: string;
  description: string;
  instructions: string;
  workspaceName: string;
  iconUrl: string | null;
  botUserId: string | null;
};

function boundedChars(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

function headline(view: SlackAgentProposalCardView, title: string): SlackMessageBlock {
  return {
    type: "section",
    block_id: "opengeni_agent_proposal_head",
    text: { type: "mrkdwn", text: `${title}\n${escapeSlackMrkdwn(view.description)}` },
    ...(view.iconUrl
      ? { accessory: { type: "image" as const, image_url: view.iconUrl, alt_text: view.name } }
      : {}),
  };
}

/** The card a chat posts: what would be created, with Create and Cancel. */
export function buildSlackAgentProposalCard(view: SlackAgentProposalCardView): {
  text: string;
  blocks: SlackMessageBlock[];
} {
  const name = escapeSlackMrkdwn(view.name);
  const workspace = escapeSlackMrkdwn(view.workspaceName);
  const instructions = view.instructions.trim();
  return {
    text: `New agent: ${view.name}`,
    blocks: [
      headline(view, `*New agent: ${name}*`),
      ...(instructions
        ? [
            {
              type: "section" as const,
              block_id: "opengeni_agent_proposal_instructions",
              text: {
                type: "mrkdwn" as const,
                text: `*Instructions*\n${escapeSlackMrkdwn(boundedChars(instructions, CARD_INSTRUCTIONS_MAX_CHARS))}`,
              },
            },
          ]
        : []),
      {
        type: "context",
        block_id: "opengeni_agent_proposal_where",
        elements: [
          {
            type: "mrkdwn",
            text: `Works in *${workspace}* · Called with ${slackAgentCallText(view, view.botUserId)} · An admin of ${workspace} can create it`,
          },
        ],
      },
      {
        type: "actions",
        block_id: "opengeni_agent_proposal_actions",
        elements: [
          {
            type: "button",
            action_id: SLACK_AGENT_PROPOSAL_CREATE_ACTION_ID,
            value: view.proposalId,
            text: { type: "plain_text", text: "Create" },
            style: "primary",
          },
          {
            type: "button",
            action_id: SLACK_AGENT_PROPOSAL_CANCEL_ACTION_ID,
            value: view.proposalId,
            text: { type: "plain_text", text: "Cancel" },
          },
        ],
      },
    ],
  };
}

/** The card once settled: created (and how to call it), or cancelled. */
export function buildSlackAgentProposalSettledCard(
  view: SlackAgentProposalCardView,
  outcome:
    | { kind: "created"; bySlackUserId: string | null }
    | {
        kind: "cancelled";
        bySlackUserId: string | null;
      },
): { text: string; blocks: SlackMessageBlock[] } {
  const name = escapeSlackMrkdwn(view.name);
  const by = outcome.bySlackUserId ? ` by <@${outcome.bySlackUserId}>` : "";
  if (outcome.kind === "cancelled") {
    return {
      text: `${view.name} was not created.`,
      blocks: [
        {
          type: "section",
          block_id: "opengeni_agent_proposal_head",
          text: { type: "mrkdwn", text: `*${name}* was not created.` },
        },
        {
          type: "context",
          block_id: "opengeni_agent_proposal_where",
          elements: [{ type: "mrkdwn", text: `Cancelled${by}` }],
        },
      ],
    };
  }
  const call = slackAgentCallText(view, view.botUserId);
  return {
    text: `${view.name} is ready. Ask it with ${call}`,
    blocks: [
      headline(view, `*${name}* is ready`),
      {
        type: "context",
        block_id: "opengeni_agent_proposal_where",
        elements: [
          {
            type: "mrkdwn",
            text: `Ask it with ${call} · Works in *${escapeSlackMrkdwn(view.workspaceName)}* · Created${by}`,
          },
        ],
      },
    ],
  };
}

function iconUrlFor(
  deps: Pick<ApiRouteDeps, "settings">,
  workspaceId: string,
  avatar: SessionAvatar,
): string | null {
  const secret = deps.settings.slackSigningSecret;
  const base = deps.settings.publicBaseUrl;
  return secret && base ? sessionAvatarImageUrl(base, secret, { workspaceId, avatar }) : null;
}

async function cardView(
  deps: ApiRouteDeps,
  proposal: SlackAgentProposal,
  botUserId: string | null,
): Promise<SlackAgentProposalCardView> {
  return {
    proposalId: proposal.id,
    name: proposal.name,
    description: proposal.description,
    instructions: proposal.instructions,
    workspaceName:
      (await getWorkspace(deps.db, proposal.targetWorkspaceId))?.name ?? "its workspace",
    iconUrl: iconUrlFor(deps, proposal.targetWorkspaceId, proposal.avatar),
    botUserId,
  };
}

/**
 * `slack_agent_propose`: post a confirmation card in this chat's Slack thread.
 * Everything about where it goes comes from the chat's own Slack interaction.
 */
export async function proposeSlackAgentFromChat(
  deps: ApiRouteDeps,
  input: { grant: AccessGrant; sessionId: string; proposal: SlackAgentProposalInput },
): Promise<SlackAgentProposalResult> {
  const refuse = (message: string): SlackAgentProposalResult => ({ status: "refused", message });
  if (!deps.settings.slackWorkspaceRoutingEnabled) {
    return refuse("Agents cannot be created from Slack here.");
  }
  const interaction = await getSlackInteractionForSession(deps.db, {
    accountId: input.grant.accountId,
    workspaceId: input.grant.workspaceId,
    sessionId: input.sessionId,
  });
  if (!interaction) return refuse("Only a chat started from Slack can propose an agent.");
  const installation = await resolveSlackInstallationRoute(deps.db, interaction.slackTeamId);
  if (
    !installation ||
    installation.accountId !== interaction.accountId ||
    installation.connectionId !== interaction.connectionId
  ) {
    return refuse("This chat's Slack installation changed.");
  }
  if (interaction.routeKey !== `${interaction.slackChannelId}:${interaction.slackThreadTs}`) {
    return refuse("This chat has no Slack thread to post the card in yet. Try again shortly.");
  }
  const home = { accountId: installation.accountId, workspaceId: installation.workspaceId };

  // The workspace: one the person behind this chat can use, never a personal
  // one. Names are matched without case; an id works too.
  const candidates = (
    await listNamedSubjectSlackRoutableWorkspaces(deps.db, {
      accountId: home.accountId,
      subjectId: interaction.owningSubjectId,
    })
  ).filter((candidate) => !candidate.personal);
  const wanted = input.proposal.workspace?.trim();
  const target = wanted
    ? candidates.find(
        (candidate) =>
          candidate.workspaceId === wanted ||
          candidate.label.trim().toLowerCase() === wanted.toLowerCase(),
      )
    : candidates.find((candidate) => candidate.workspaceId === input.grant.workspaceId);
  if (!target) {
    const names = candidates.map((candidate) => candidate.label).join(", ");
    return refuse(
      wanted
        ? `No shared workspace called "${wanted}" that this person can use.${names ? ` Workspaces: ${names}.` : ""} Ask which one.`
        : `This chat's workspace is personal; an agent works in a shared workspace.${names ? ` Workspaces: ${names}.` : ""} Ask which one.`,
    );
  }

  // The same rules as the admin form: name, description, instructions, icon.
  const request = CreateSlackAgentRequest.safeParse({
    connectionId: installation.connectionId,
    name: input.proposal.name,
    description: input.proposal.description,
    avatar: input.proposal.avatar,
    instructions: input.proposal.instructions ?? "",
  });
  if (!request.success) {
    return refuse(
      `Fix the proposal: ${request.error.issues
        .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  // An admin confirms exactly what the card shows, so a proposal's
  // instructions never exceed what fits on it. Longer ones are set in the
  // agent settings.
  if ([...request.data.instructions].length > CARD_INSTRUCTIONS_MAX_CHARS) {
    return refuse(
      `Instructions are limited to ${CARD_INSTRUCTIONS_MAX_CHARS} characters here. Shorten them; an admin can add more in the agent's settings.`,
    );
  }
  const loaded = await loadSlackAgentsForConnection(deps, home, installation.connectionId);
  const nameKey = slackAgentNameKey(request.data.name);
  if (loaded.records.some((agent) => agent.nameKey === nameKey)) {
    return refuse(`An agent called ${request.data.name} already exists. Ask for another name.`);
  }
  if (request.data.avatar.kind === "image") {
    // An image icon is a file the agent's own workspace shows to everyone.
    if (target.workspaceId !== input.grant.workspaceId) {
      return refuse(
        `An image icon must be a file in ${target.label}, the agent's workspace. Use an emoji or a built-in icon instead.`,
      );
    }
    try {
      await requireUsableSessionAvatar(deps, input.grant, request.data.avatar, {
        sharedWithWorkspace: true,
      });
    } catch (error) {
      if (error instanceof HTTPException) return refuse(error.message);
      throw error;
    }
  }

  const proposalId = crypto.randomUUID();
  const proposal = await insertSlackAgentProposal(deps.db, home, {
    id: proposalId,
    connectionId: installation.connectionId,
    slackTeamId: interaction.slackTeamId,
    targetAccountId: target.accountId,
    targetWorkspaceId: target.workspaceId,
    proposedBySessionId: input.sessionId,
    proposedBySlackUserId: interaction.lastInboundSlackUserId ?? interaction.initiatingSlackUserId,
    slackChannelId: interaction.slackChannelId,
    slackThreadTs: interaction.slackThreadTs,
    messageOperationId: slackAgentDeterministicUuid(`slack-agent-proposal:${proposalId}`),
    name: request.data.name,
    nameKey,
    description: request.data.description,
    avatar: request.data.avatar,
    instructions: request.data.instructions,
  });
  const client = await createOpenGeniSlackBotInteractionClient(deps, {
    ...home,
    connectionId: installation.connectionId,
    subjectId: SLACK_PROPOSAL_BOT_SUBJECT_ID,
  });
  const card = buildSlackAgentProposalCard(await cardView(deps, proposal, installation.botUserId));
  const posted = await client.postMessage({
    operationId: proposal.messageOperationId,
    channelId: proposal.slackChannelId,
    threadTimestamp: proposal.slackThreadTs,
    text: card.text,
    blocks: card.blocks,
  });
  await setSlackAgentProposalMessage(deps.db, home, {
    proposalId,
    slackMessageTs: posted.timestamp,
  });
  return {
    status: "proposed",
    proposalId,
    message: `Posted a card in this thread with Create and Cancel. Nothing is created until an admin of ${target.label} presses Create. Tell the person that in one short sentence.`,
  };
}

/** Slack's human-session Knowledge actor for the person who pressed Create. */
function slackHumanKnowledgeContext(grant: AccessGrant): KnowledgeContext {
  const canWrite = hasPermission(grant.permissions, "documents:manage");
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    actor: {
      kind: "human",
      principalKind: "human_session",
      subjectId: grant.subjectId,
      writeScopes: canWrite ? ["workspace"] : [],
      review: canWrite,
      settingsScopes: [],
    },
  };
}

/**
 * One click on a proposal card, from the inbox. The card's button carries only
 * the proposal id; everything else is read from the stored proposal.
 */
export async function handleSlackAgentProposalAction(
  deps: ApiRouteDeps,
  home: { accountId: string; workspaceId: string },
  entry: SlackInteractionInboxEntry,
  actionId: string,
  proposalId: string,
): Promise<void> {
  if (!deps.settings.slackWorkspaceRoutingEnabled) return;
  const proposal = await getSlackAgentProposal(deps.db, home, { proposalId });
  if (
    !proposal ||
    proposal.connectionId !== entry.connectionId ||
    proposal.slackTeamId !== entry.slackTeamId ||
    proposal.slackChannelId !== entry.slackChannelId
  ) {
    return;
  }
  // The click must come from the card itself.
  const cardTs =
    proposal.slackMessageTs ??
    (
      await getSlackBotPostOperation(
        deps.db,
        home.workspaceId,
        entry.connectionId,
        proposal.messageOperationId,
      )
    )?.slackMessageTimestamp ??
    null;
  if (cardTs !== entry.slackMessageTs) return;

  const installation = await resolveSlackInstallationRoute(deps.db, entry.slackTeamId);
  const botUserId = installation?.botUserId ?? null;
  const client = await createOpenGeniSlackBotInteractionClient(deps, {
    ...home,
    connectionId: entry.connectionId,
    subjectId: SLACK_PROPOSAL_BOT_SUBJECT_ID,
  });
  const view = await cardView(deps, proposal, botUserId);
  const replaceCard = async (
    settled: SlackAgentProposal,
    outcome: "created" | "cancelled",
  ): Promise<void> => {
    const card = buildSlackAgentProposalSettledCard(view, {
      kind: outcome,
      bySlackUserId: settled.decidedBySlackUserId,
    });
    await client.updateMessage({
      operationId: slackAgentDeterministicUuid(
        `slack-agent-proposal-card:${proposal.id}:${outcome}`,
      ),
      channelId: entry.slackChannelId,
      timestamp: entry.slackMessageTs,
      text: card.text,
      blocks: card.blocks,
    });
  };
  const tellPrivately = async (reason: string, text: string): Promise<void> => {
    await client.postMessage({
      operationId: slackAgentDeterministicUuid(
        `slack-agent-proposal-reply:${proposal.id}:${entry.id}:${reason}`,
      ),
      userId: entry.slackUserId,
      text,
    });
  };

  if (proposal.status === "created") return await replaceCard(proposal, "created");
  if (proposal.status === "cancelled") return await replaceCard(proposal, "cancelled");

  // Who may decide: a current admin of the target workspace, through the
  // person's own linked identity and live grant.
  const link = await getSlackBotUserLink(
    deps.db,
    home.workspaceId,
    entry.connectionId,
    entry.slackUserId,
  );
  const grant = link
    ? await resolveSlackTargetAuthority(deps.db, {
        subjectId: link.subjectId,
        targetAccountId: proposal.targetAccountId,
        targetWorkspaceId: proposal.targetWorkspaceId,
      })
    : null;
  const admin = Boolean(grant && hasPermission(grant.permissions, "workspace:admin"));

  if (actionId === SLACK_AGENT_PROPOSAL_CANCEL_ACTION_ID) {
    if (!admin && entry.slackUserId !== proposal.proposedBySlackUserId) {
      return await tellPrivately(
        "cancel_denied",
        `Only the person who asked or an admin of the ${view.workspaceName} workspace can cancel this.`,
      );
    }
    const cancelled = await transitionSlackAgentProposal(deps.db, home, {
      proposalId: proposal.id,
      from: ["pending"],
      to: "cancelled",
      decidedBySubjectId: link?.subjectId ?? null,
      decidedBySlackUserId: entry.slackUserId,
    });
    const current = cancelled ?? (await getSlackAgentProposal(deps.db, home, { proposalId }));
    if (current?.status === "cancelled") return await replaceCard(current, "cancelled");
    if (current?.status === "created") return await replaceCard(current, "created");
    return;
  }
  if (actionId !== SLACK_AGENT_PROPOSAL_CREATE_ACTION_ID) return;
  if (!admin || !grant) {
    return await tellPrivately(
      "create_denied",
      `Only an admin of the ${view.workspaceName} workspace can create ${proposal.name}.`,
    );
  }

  // Claim it, so a Cancel cannot land while the agent is being created. A
  // claim left by an interrupted click is taken over; creating is idempotent.
  const claimed = await transitionSlackAgentProposal(deps.db, home, {
    proposalId: proposal.id,
    from: ["pending", "creating"],
    to: "creating",
    decidedBySubjectId: grant.subjectId,
    decidedBySlackUserId: entry.slackUserId,
  });
  if (!claimed) {
    const current = await getSlackAgentProposal(deps.db, home, { proposalId });
    if (current?.status === "created") return await replaceCard(current, "created");
    if (current?.status === "cancelled") return await replaceCard(current, "cancelled");
    return;
  }
  const outcome = await createSlackAgent(deps, {
    grant,
    agentId: proposal.id,
    request: {
      connectionId: proposal.connectionId,
      name: proposal.name,
      description: proposal.description,
      avatar: proposal.avatar,
      instructions: proposal.instructions,
    },
    memoryContext: async () => slackHumanKnowledgeContext(grant),
  });
  if (outcome.kind !== "created") {
    await transitionSlackAgentProposal(deps.db, home, {
      proposalId: proposal.id,
      from: ["creating"],
      to: "pending",
    });
    const reason =
      outcome.kind === "name_taken"
        ? `Another agent is already called ${proposal.name}, so it was not created. Ask in the thread for another name.`
        : outcome.kind === "slack_bot_unavailable"
          ? `The Opengeni app is not available in the ${view.workspaceName} workspace, so ${proposal.name} was not created. Turn it on in Opengeni under Capabilities, then Slack, and press Create again.`
          : `${proposal.name} needs a shared workspace, so it was not created.`;
    return await tellPrivately(outcome.kind, reason);
  }
  const created = await transitionSlackAgentProposal(deps.db, home, {
    proposalId: proposal.id,
    from: ["creating"],
    to: "created",
    createdSlackAgentId: outcome.agent.id,
  });
  const current = created ?? (await getSlackAgentProposal(deps.db, home, { proposalId }));
  if (current) await replaceCard(current, "created");
}
