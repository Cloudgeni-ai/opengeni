/* ----------------------------------------------------------------------------
   A chat's or an agent's avatar, as the web SessionAvatar draws it: a rounded
   square (never a person's round monogram). Emoji sit on a soft tint of their
   hue; icons and letters are white on it. An image avatar is a workspace
   image each viewer opens with their own access, through the host's client;
   until it loads, or when they cannot open it, the chat's initials show.
   Colours, initials and fallbacks come from @opengeni/react/session-avatar-model,
   so web and native read identically.
   -------------------------------------------------------------------------- */
import type { OpenGeniClient, Session, SessionAvatar as SessionAvatarValue } from "@opengeni/sdk";
import {
  sessionAvatarFallbackHue,
  sessionAvatarInitials,
  sessionAvatarTileHex,
  sessionAgentRef,
  useSessionAgentInfo,
  type SessionAgentClient,
} from "@opengeni/react/session-avatar-model";
import { sessionDisplayTitle } from "@opengeni/react/session-list-model";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Image, Text, View } from "react-native";
import { Icon, type NativeIconName } from "./icon";
import { iconNodes } from "./icon-nodes.generated";
import { useNativeTimelineTheme } from "./theme";

/** What an image avatar needs: the person's own authorized access to the workspace file. */
export type SessionAvatarClient = Pick<
  OpenGeniClient,
  "getRetainedArtifact" | "createRetainedArtifactDownloadUrl"
>;

export type SessionAvatarSize = "xs" | "sm" | "md" | "lg";

/** The web sizes (pt for px): box, corner radius, icon, letters and emoji. */
const SIZE: Record<
  SessionAvatarSize,
  { box: number; radius: number; icon: number; text: number; emoji: number }
> = {
  xs: { box: 16, radius: 4, icon: 10, text: 8, emoji: 10 },
  sm: { box: 20, radius: 5, icon: 12, text: 9, emoji: 12 },
  md: { box: 32, radius: 6, icon: 16, text: 12, emoji: 16 },
  lg: { box: 48, radius: 8, icon: 24, text: 16, emoji: 24 },
};

export interface SessionAvatarProps {
  avatar: SessionAvatarValue;
  /** The chat's (or agent's) name, for an image's initials fallback. */
  name: string;
  /** Where an image avatar lives. */
  workspaceId: string;
  /** Keeps an image's fallback colour stable (the chat or agent id). Defaults to the name. */
  seed?: string | undefined;
  size?: SessionAvatarSize | undefined;
  /** Loads image avatars; without it they show their initials. */
  client?: SessionAvatarClient | null | undefined;
}

export function SessionAvatar({
  avatar,
  name,
  workspaceId,
  seed,
  size = "sm",
  client,
}: SessionAvatarProps) {
  const theme = useNativeTimelineTheme();
  const dims = SIZE[size];
  if (avatar.kind === "image") {
    const fallback = (
      <LettersTile
        letters={sessionAvatarInitials(name)}
        hue={sessionAvatarFallbackHue(seed ?? name)}
        size={size}
      />
    );
    return client ? (
      <ImageAvatar
        key={`${workspaceId}:${avatar.artifactId}`}
        client={client}
        workspaceId={workspaceId}
        artifactId={avatar.artifactId}
        size={size}
        fallback={fallback}
      />
    ) : (
      fallback
    );
  }
  if (avatar.kind === "emoji") {
    const tone = theme.scheme === "dark" ? "emojiDark" : "emojiLight";
    return (
      <Tile size={size} kind="emoji" color={sessionAvatarTileHex(tone, avatar.hue)}>
        <Text
          allowFontScaling={false}
          style={{
            fontSize: dims.emoji,
            lineHeight: Math.round(dims.emoji * 1.25),
            textAlign: "center",
            includeFontPadding: false,
          }}
        >
          {avatar.emoji}
        </Text>
      </Tile>
    );
  }
  if (avatar.kind === "icon") {
    // A newer server may offer icons this build does not draw yet.
    const icon: NativeIconName = avatar.icon in iconNodes ? avatar.icon : "bot";
    return (
      <Tile size={size} kind="icon" color={sessionAvatarTileHex("solid", avatar.hue)}>
        <Icon name={icon} size={dims.icon} color="#ffffff" strokeWidth={2.25} />
      </Tile>
    );
  }
  return <LettersTile letters={avatar.letters} hue={avatar.hue} size={size} />;
}

/** A client that loads image avatars and, for a chat with an agent, the agent's current icon. */
export type SessionIdentityClient = SessionAvatarClient & Partial<SessionAgentClient>;

export interface NativeSessionIdentity {
  /** The avatar the chat's header shows beside its title, or null for none. */
  avatar: Omit<SessionAvatarProps, "size"> | null;
  /** The agent the chat belongs to, named under the title as the web's agent chip names it. */
  agentName: string | null;
}

/**
 * Who a chat is, for its header, as the web header shows it: a chat with an
 * agent shows that agent's current icon (its initials when it has none) and
 * name; any other chat shows its own avatar, when it has one.
 * The result keeps its identity until what it shows changes, so it can sit
 * in navigation options.
 */
export function useNativeSessionIdentity(
  session: Session | null | undefined,
  client: SessionIdentityClient | null | undefined,
): NativeSessionIdentity {
  const workspaceId = session?.workspaceId ?? "";
  const agent = useSessionAgentInfo(workspaceId, session ? sessionAgentRef(session) : null, () =>
    client && typeof client.getAgent === "function" ? (client as SessionAgentClient) : null,
  );
  const shown: { avatar: SessionAvatarValue; name: string; seed: string } | null = !session
    ? null
    : agent
      ? { avatar: agent.avatar, name: agent.name, seed: agent.id }
      : session.avatar
        ? { avatar: session.avatar, name: sessionDisplayTitle(session), seed: session.id }
        : null;
  const agentName = agent?.name ?? null;
  const key = shown ? JSON.stringify([shown.avatar, shown.name, shown.seed]) : null;
  return useMemo(
    () => ({
      avatar: shown ? { ...shown, workspaceId, client } : null,
      agentName,
    }),
    // `shown` is read through its key: a refreshed session with the same avatar keeps the result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, agentName, workspaceId, client],
  );
}

function Tile({
  size,
  kind,
  color,
  children,
}: {
  size: SessionAvatarSize;
  kind: "emoji" | "icon" | "letters" | "image";
  color: string;
  children: ReactNode;
}) {
  const dims = SIZE[size];
  return (
    <View
      testID={`session-avatar-${kind}`}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: dims.box,
        height: dims.box,
        borderRadius: dims.radius,
        backgroundColor: color,
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        flexShrink: 0,
      }}
    >
      {children}
    </View>
  );
}

function LettersTile({
  letters,
  hue,
  size,
}: {
  letters: string;
  hue: number;
  size: SessionAvatarSize;
}) {
  const dims = SIZE[size];
  return (
    <Tile size={size} kind="letters" color={sessionAvatarTileHex("solid", hue)}>
      <Text
        allowFontScaling={false}
        numberOfLines={1}
        style={{
          color: "#ffffff",
          fontSize: dims.text,
          lineHeight: Math.round(dims.text * 1.25),
          fontWeight: "600",
          textAlign: "center",
          includeFontPadding: false,
        }}
      >
        {letters.toUpperCase()}
      </Text>
    </Tile>
  );
}

function ImageAvatar({
  client,
  workspaceId,
  artifactId,
  size,
  fallback,
}: {
  client: SessionAvatarClient;
  workspaceId: string;
  artifactId: string;
  size: SessionAvatarSize;
  fallback: ReactNode;
}) {
  const theme = useNativeTimelineTheme();
  const [url, setUrl] = useState<string | null>(() =>
    peekAvatarImageUrl(client, workspaceId, artifactId),
  );
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void loadAvatarImageUrl(client, workspaceId, artifactId).then((next) => {
      if (active) setUrl(next);
    });
    return () => {
      active = false;
    };
  }, [client, workspaceId, artifactId]);
  if (!url || failed) return <>{fallback}</>;
  return (
    <Tile size={size} kind="image" color={theme.colors["surface-2"]}>
      <Image
        source={{ uri: url }}
        resizeMode="cover"
        accessibilityIgnoresInvertColors
        style={{ width: "100%", height: "100%" }}
        onError={() => {
          forgetAvatarImage(client, workspaceId, artifactId);
          setFailed(true);
        }}
      />
    </Tile>
  );
}

/* Image avatar URLs ------------------------------------------------------------
   A chat list shows the same few avatars many times, and remounts them as it
   scrolls or refreshes. Each avatar's signed download URL is read once per
   client and reused while comfortably inside its lifetime, so rows neither
   flash their initials nor download the image again. Failures and files that
   are not images are never kept, so the next showing asks again. */

const MAX_IMAGE_ENTRIES = 128;
const URL_EXPIRY_MARGIN_MS = 60_000;

type ImageEntry = { pending: Promise<string | null>; url?: string; expiresAt?: number };

const imageEntries = new WeakMap<object, Map<string, ImageEntry>>();

function entriesOf(client: SessionAvatarClient): Map<string, ImageEntry> {
  let entries = imageEntries.get(client);
  if (!entries) {
    entries = new Map();
    imageEntries.set(client, entries);
  }
  return entries;
}

function freshEntry(entries: Map<string, ImageEntry>, key: string): ImageEntry | undefined {
  const entry = entries.get(key);
  if (entry?.expiresAt !== undefined && Date.now() >= entry.expiresAt) {
    entries.delete(key);
    return undefined;
  }
  return entry;
}

function peekAvatarImageUrl(
  client: SessionAvatarClient,
  workspaceId: string,
  artifactId: string,
): string | null {
  return freshEntry(entriesOf(client), `${workspaceId}:${artifactId}`)?.url ?? null;
}

function forgetAvatarImage(client: SessionAvatarClient, workspaceId: string, artifactId: string) {
  entriesOf(client).delete(`${workspaceId}:${artifactId}`);
}

/** The image's signed URL, or null when it is gone, not an image, or out of reach. */
export function loadAvatarImageUrl(
  client: SessionAvatarClient,
  workspaceId: string,
  artifactId: string,
): Promise<string | null> {
  const entries = entriesOf(client);
  const key = `${workspaceId}:${artifactId}`;
  const existing = freshEntry(entries, key);
  if (existing) {
    // Most recently used last, so trimming drops the oldest.
    entries.delete(key);
    entries.set(key, existing);
    return existing.pending;
  }
  const entry: ImageEntry = { pending: Promise.resolve(null) };
  entry.pending = (async () => {
    try {
      const metadata = await client.getRetainedArtifact(workspaceId, artifactId);
      if (
        !metadata.available ||
        metadata.artifactId !== artifactId ||
        !metadata.contentType.toLowerCase().startsWith("image/")
      ) {
        if (entries.get(key) === entry) entries.delete(key);
        return null;
      }
      const download = await client.createRetainedArtifactDownloadUrl(workspaceId, metadata);
      const expires = Date.parse(download.expiresAt);
      if (entries.get(key) === entry) {
        entry.url = download.url;
        entry.expiresAt = Number.isFinite(expires)
          ? expires - URL_EXPIRY_MARGIN_MS
          : Date.now() + URL_EXPIRY_MARGIN_MS;
      }
      return download.url;
    } catch {
      if (entries.get(key) === entry) entries.delete(key);
      return null;
    }
  })();
  entries.set(key, entry);
  while (entries.size > MAX_IMAGE_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
  return entry.pending;
}
