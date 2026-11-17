import { fontStyle, Icon, useNativeTimelineTheme } from "@opengeni/react-native/timeline";
import type { ArtifactCatalogItem, OpenGeniLinkTarget } from "@opengeni/sdk";
import { useEffect, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { ArtifactThumbnail, type ArtifactThumbnailClient } from "@/artifact-card";
import { cachedArtifact, loadArtifactItem, type ArtifactItemClient } from "@/artifact-library";
import { ARTIFACT_KIND_ICON, ARTIFACT_KIND_LABEL, viewerParamsForLink } from "@/artifacts";

/**
 * An artifact, Site or file linked on its own line in a chat: a card with its
 * still, title and type, which opens the same viewer as the Artifacts list.
 */
export function ArtifactLinkCard({
  client,
  workspaceId,
  target,
  children,
  onOpen,
}: {
  client: ArtifactThumbnailClient & ArtifactItemClient;
  workspaceId: string;
  target: OpenGeniLinkTarget;
  /** The link's own text, the title until the artifact's record arrives. */
  children: ReactNode;
  onOpen: () => void;
}) {
  const theme = useNativeTimelineTheme();
  const c = theme.colors;
  const params = viewerParamsForLink(target, workspaceId);
  const [item, setItem] = useState<ArtifactCatalogItem | null>(() =>
    params ? cachedArtifact(client, params.workspaceId, params.kind, params.id) : null,
  );
  useEffect(() => {
    if (!params || item) return;
    let active = true;
    void loadArtifactItem(client, params.workspaceId, params.kind, params.id, undefined)
      .then((next) => active && setItem(next))
      .catch(() => undefined);
    return () => {
      active = false;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the target names what is loaded
  }, [client, params?.id, params?.workspaceId]);
  const kind = item?.kind ?? params?.kind ?? "file";
  // A retained file's record has no name; the link's words are better than "File".
  const title = item && item.title !== "File" ? item.title : null;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onOpen}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        marginVertical: 6,
        padding: 6,
        paddingRight: 14,
        borderRadius: 18,
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: pressed ? c.hover : c["surface-1"],
        alignSelf: "stretch",
      })}
    >
      <View style={{ width: 84, height: 58, borderRadius: 12, overflow: "hidden" }}>
        {item ? (
          <ArtifactThumbnail
            client={client}
            workspaceId={params!.workspaceId}
            item={item}
            glyphSize={20}
          />
        ) : (
          <View
            style={{
              flex: 1,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: c["surface-2"],
            }}
          >
            <Icon name={ARTIFACT_KIND_ICON[kind]} size={20} color={c["fg-subtle"]} />
          </View>
        )}
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text
          numberOfLines={2}
          style={{ ...fontStyle(theme, 600), fontSize: 15, lineHeight: 20, color: c.fg }}
        >
          {title ?? children}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
          <Icon name={ARTIFACT_KIND_ICON[kind]} size={12} color={c["fg-subtle"]} />
          <Text style={{ ...fontStyle(theme), fontSize: 13, color: c["fg-muted"] }}>
            {item || kind !== "document" ? ARTIFACT_KIND_LABEL[kind] : "Artifact"}
          </Text>
        </View>
      </View>
      <Icon name="chevron-right" size={16} color={c["fg-subtle"]} />
    </Pressable>
  );
}
