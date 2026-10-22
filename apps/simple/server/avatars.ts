import { getProfile, listProfiles, upsertProfile } from "./db";
import { api } from "./opengeni";
import { avatarPrompt } from "./prompts";

const POLL_MS = 4000;
const TIMEOUT_MS = 6 * 60 * 1000;
const running = new Set<string>();

const RECEIPT =
  /"kind"\s*:\s*"generated_image"[^{}]*?"artifactId"\s*:\s*"([0-9a-f-]{36})"|"artifactId"\s*:\s*"([0-9a-f-]{36})"[^{}]*?"kind"\s*:\s*"generated_image"/;

/**
 * Paints an agent's avatar in a hidden one-off session that may only generate
 * images, then remembers the retained artifact. The agent's own chat never
 * sees this work.
 */
export async function startAvatarJob(workspaceId: string, sessionId: string, hint?: string | null) {
  if (running.has(sessionId)) return;
  const profile = getProfile(sessionId);
  const name = profile?.name ?? "Agent";
  running.add(sessionId);
  upsertProfile(workspaceId, sessionId, {
    avatarStatus: "pending",
    ...(hint ? { avatarPrompt: hint } : {}),
  });
  try {
    const studio = await api.createSession(workspaceId, {
      idempotencyKey: `simple-app:avatar:${sessionId}:${crypto.randomUUID()}`,
      reasoningEffort: "low",
      metadata: { simpleApp: { kind: "studio", forSessionId: sessionId } },
      memoryScope: "off",
      sandboxBackend: "none",
      agent: {
        capabilities: { from: "none", media: true },
        identity: "You are an illustrator that makes app avatars.",
      },
      initialMessage: avatarPrompt({
        name,
        description: profile?.description ?? null,
        hint: hint ?? profile?.avatarPrompt ?? null,
      }),
    } as Parameters<typeof api.createSession>[1]);
    upsertProfile(workspaceId, sessionId, { avatarJobSessionId: studio.id });
    const artifactId = await waitForImage(workspaceId, studio.id);
    upsertProfile(workspaceId, sessionId, {
      avatarArtifactId: artifactId,
      avatarStatus: artifactId ? "ready" : profile?.avatarArtifactId ? "ready" : "failed",
      ...(artifactId ? {} : { avatarArtifactId: profile?.avatarArtifactId ?? null }),
    });
    await api.updateSessionArchive(workspaceId, studio.id, { archived: true }).catch(() => {});
  } catch (error) {
    console.warn(`Avatar job failed for ${sessionId}`, error);
    upsertProfile(workspaceId, sessionId, {
      avatarStatus: profile?.avatarArtifactId ? "ready" : "failed",
    });
  } finally {
    running.delete(sessionId);
  }
}

async function waitForImage(workspaceId: string, studioSessionId: string): Promise<string | null> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    await Bun.sleep(POLL_MS);
    const [events, session] = await Promise.all([
      api.listEvents(workspaceId, studioSessionId, { limit: 200 } as never),
      api.getSession(workspaceId, studioSessionId),
    ]);
    const match = RECEIPT.exec(JSON.stringify(events));
    if (match) return match[1] ?? match[2] ?? null;
    if (session.status === "failed" || session.status === "cancelled") return null;
    if (session.status === "idle" && session.lastSequence > 3 && !session.activeTurnId) {
      // The turn ended without an image (no image route, or the model declined).
      const final = RECEIPT.exec(
        JSON.stringify(
          await api.listEvents(workspaceId, studioSessionId, {
            limit: 500,
          } as never),
        ),
      );
      return final ? (final[1] ?? final[2] ?? null) : null;
    }
  }
  return null;
}

/** After a restart, retry avatars that were mid-flight. */
export function resumeAvatarJobs(workspaceId: string, { retryFailed = false } = {}) {
  for (const profile of listProfiles(workspaceId)) {
    const due =
      profile.avatarStatus === "pending" || (retryFailed && profile.avatarStatus === "failed");
    if (due && !running.has(profile.sessionId)) {
      void startAvatarJob(workspaceId, profile.sessionId);
    }
  }
}
