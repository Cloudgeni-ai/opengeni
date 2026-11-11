import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  agentAvatar,
  oklchToHex,
  SESSION_AVATAR_TILE,
  sessionAgentRef,
  sessionAvatarFallbackHue,
  sessionAvatarInitials,
  sessionAvatarTileCss,
  sessionAvatarTileHex,
} from "../src/session-avatar-model";

const AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";

test("OKLCH tile colours convert to the sRGB a browser paints", () => {
  // Browser-resolved values of the web's own oklch tokens (web-tokens.gen.ts),
  // two of them outside the sRGB gamut and clipped.
  expect(oklchToHex(0.5, 0.19, 22)).toBe("#b7162d");
  expect(oklchToHex(0.77, 0.12, 22)).toBe("#f79491");
  expect(oklchToHex(0.52, 0.2, 22)).toBe("#c2152f");
  expect(oklchToHex(0.76, 0.13, 22)).toBe("#f98e8b");
  expect(sessionAvatarTileHex("solid", 22)).toBe(oklchToHex(0.56, 0.11, 22));
  expect(sessionAvatarTileCss("solid", 210)).toBe("oklch(0.56 0.11 210)");
});

test("the web emoji tile uses the shared tint", () => {
  const source = readFileSync(
    join(import.meta.dir, "../src/app/components/session/session-avatar.tsx"),
    "utf8",
  );
  const { emojiLight, emojiDark } = SESSION_AVATAR_TILE;
  expect(source).toContain(`bg-[oklch(${emojiLight.l}_${emojiLight.c}_var(--avatar-hue))]`);
  expect(source).toContain(`dark:bg-[oklch(${emojiDark.l}_${emojiDark.c}_var(--avatar-hue))]`);
});

test("initials and fallback hues are stable", () => {
  expect(sessionAvatarInitials("  release   manager  ")).toBe("RM");
  expect(sessionAvatarInitials("🤖")).toBe("?");
  expect(sessionAvatarFallbackHue("same seed")).toBe(sessionAvatarFallbackHue("same seed"));
  expect(sessionAvatarFallbackHue("same seed")).toBeLessThan(360);
});

test("an agent without an icon shows its initials, or a bot icon without letters", () => {
  const hue = sessionAvatarFallbackHue(AGENT_ID);
  expect(agentAvatar({ id: AGENT_ID, name: "Release manager", avatar: null })).toEqual({
    kind: "letters",
    letters: "RM",
    hue,
  });
  expect(agentAvatar({ id: AGENT_ID, name: "!!!", avatar: null })).toEqual({
    kind: "icon",
    icon: "bot",
    hue,
  });
  const own = { kind: "emoji", emoji: "🦊", hue: 30 } as const;
  expect(agentAvatar({ id: AGENT_ID, name: "Fox", avatar: own })).toBe(own);
});

test("only agentId names a chat's agent; Slack metadata only lends its old name", () => {
  expect(sessionAgentRef({ agentId: null, metadata: {} })).toBeNull();
  expect(
    sessionAgentRef({
      agentId: AGENT_ID,
      metadata: { slackAgent: { id: AGENT_ID, name: "Desk" } },
    }),
  ).toEqual({ id: AGENT_ID, name: "Desk" });
  expect(sessionAgentRef({ agentId: AGENT_ID, metadata: {} })).toEqual({
    id: AGENT_ID,
    name: null,
  });
});
