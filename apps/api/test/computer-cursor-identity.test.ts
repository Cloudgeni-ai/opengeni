import { expect, test } from "bun:test";
import sharp from "sharp";
import {
  computerCursorIdentity,
  cursorInitialsAvatar,
} from "../src/routes/computer-cursor-identity";
import type { AccessGrant, Session } from "@opengeni/contracts";

const session = {
  id: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  title: "Research agent",
  titleSource: "user",
  avatar: { kind: "icon", icon: "telescope", hue: 150 },
} as Session;

test("pointer identity reuses the chat profile, rendered to bounded pixels", async () => {
  const identity = await computerCursorIdentity({ db: {} } as never, {} as AccessGrant, session);
  expect(identity.label).toBe("Research agent");
  const png = Buffer.from(identity.avatarPng!, "base64");
  const metadata = await sharp(png).metadata();
  expect([metadata.width, metadata.height, metadata.format]).toEqual([64, 64, "png"]);
  expect(png.length).toBeLessThan(32 * 1024);
});

test("missing and inaccessible image avatars retain the friendly name", async () => {
  const identity = await computerCursorIdentity({ db: {} } as never, {} as AccessGrant, {
    ...session,
    avatar: { kind: "image", artifactId: "33333333333333333333333333333333" },
  });
  expect(identity.label).toBe(session.title);
  expect(JSON.stringify(identity)).not.toContain(session.id);
  const initial = cursorInitialsAvatar("  Research agent", session.id);
  expect(initial).toMatchObject({ kind: "letters", letters: "RA" });
  expect(cursorInitialsAvatar("Research agent", session.id)).toEqual(initial);
});

test("long names and expanding uppercase initials stay within the transport bounds", async () => {
  const identity = await computerCursorIdentity({ db: {} } as never, {} as AccessGrant, {
    ...session,
    title: "A".repeat(199) + "🦊".repeat(20),
  });
  expect(identity.label).toBe("A".repeat(199));
  expect(cursorInitialsAvatar("ß ß", session.id)).toMatchObject({ letters: "SS" });
});

test("a stalled avatar lookup cannot stall opening the computer", async () => {
  let lookupStarted = false;
  const started = performance.now();
  const identity = await computerCursorIdentity(
    {
      db: {
        transaction: () => {
          lookupStarted = true;
          return new Promise(() => {});
        },
      },
      objectStorage: {},
    } as never,
    {} as AccessGrant,
    { ...session, avatar: { kind: "image", artifactId: "33333333333333333333333333333333" } },
  );
  expect(lookupStarted).toBe(true);
  expect(identity).toEqual({ label: "Research agent" });
  expect(performance.now() - started).toBeLessThan(1_500);
});
