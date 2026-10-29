import { z } from "zod";
import type { TeamsGroupAudience } from "@opengeni/db";

const Member = z.object({
  id: z.string().min(1),
  aadObjectId: z.string().uuid(),
  tenantId: z.string().uuid(),
  role: z.string().optional(),
  type: z.string().optional(),
  agenticUserId: z.never().optional(),
  agenticAppId: z.never().optional(),
});
/** Connector getMembers returns the complete chat roster. Never truncate it. */
export async function resolveTeamsGroupAudience(
  raw: unknown,
  tenantId: string,
  botId: string,
  resolve: (actorId: string) => Promise<string | null>,
): Promise<TeamsGroupAudience> {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 251)
    throw new Error("teams_group_roster_unavailable");
  const result: TeamsGroupAudience = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (value && typeof value === "object" && value.id === botId) continue;
    const member = Member.parse(value);
    const actorId = member.aadObjectId.toLowerCase();
    if (
      member.id.startsWith("28:") ||
      member.tenantId.toLowerCase() !== tenantId.toLowerCase() ||
      (member.role && member.role !== "user") ||
      (member.type && member.type !== "person") ||
      seen.has(actorId)
    )
      throw new Error("teams_group_roster_unavailable");
    const subjectId = await resolve(actorId);
    if (!subjectId) throw new Error("teams_group_member_unlinked");
    seen.add(actorId);
    result.push({ actorId, subjectId });
  }
  if (!result.length || result.length > 250) throw new Error("teams_group_roster_unavailable");
  return result.sort((a, b) => a.actorId.localeCompare(b.actorId));
}
export function sameTeamsAudience(a: TeamsGroupAudience, b: TeamsGroupAudience): boolean {
  return (
    JSON.stringify(a.map((x) => [x.actorId, x.subjectId])) ===
    JSON.stringify(b.map((x) => [x.actorId, x.subjectId]))
  );
}

const MembershipChange = z.object({
  type: z.literal("conversationUpdate"),
  channelId: z.literal("msteams"),
  recipient: z.object({ id: z.string() }),
  conversation: z.object({
    id: z.string().min(1).max(512),
    conversationType: z.literal("groupChat"),
    tenantId: z.string().uuid().optional(),
  }),
  channelData: z.object({ tenant: z.object({ id: z.string().uuid() }) }),
  membersAdded: z.array(z.unknown()).max(251).optional(),
  membersRemoved: z.array(z.unknown()).max(251).optional(),
});
/** Pure decision only. The caller must be inside the SDK-authenticated callback. */
export function teamsGroupMembershipChange(
  raw: unknown,
  botId: string,
): { tenantId: string; conversationId: string } | null {
  const parsed = MembershipChange.safeParse(raw);
  if (!parsed.success) return null;
  const a = parsed.data,
    tenantId = a.channelData.tenant.id.toLowerCase();
  if (
    a.recipient.id.toLowerCase() !== botId.toLowerCase() ||
    !(a.membersAdded?.length || a.membersRemoved?.length) ||
    (a.conversation.tenantId && a.conversation.tenantId.toLowerCase() !== tenantId)
  )
    return null;
  return { tenantId, conversationId: a.conversation.id };
}
