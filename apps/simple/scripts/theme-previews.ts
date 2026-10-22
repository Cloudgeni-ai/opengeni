/**
 * Paints the same sample agents in every candidate avatar house style, so the
 * styles can be compared side by side. Uses the same hidden image-only studio
 * sessions as real avatars.
 *
 *   OPENGENI_SIMPLE_API_URL=... OPENGENI_SIMPLE_API_KEY_FILE=... \
 *     bun scripts/theme-previews.ts <workspaceId> <outDir> [themeId...]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { api, downloadImage } from "../server/opengeni";
import { generatedImageIds } from "../server/receipts";
import { AVATAR_THEMES } from "../server/themes";

const PER_IMAGE_ACCENT = "the accent color listed for that image";

const SUBJECTS = [
  { key: "geni", name: "Geni", subject: "a magical genie spark, the main assistant" },
  { key: "coach", name: "Run Coach", subject: "a running shoe, for a running coach" },
  { key: "finance", name: "Money", subject: "a small stack of gold coins, for a finance helper" },
  { key: "meals", name: "Meals", subject: "a steaming cooking pot, for a meal planner" },
];

const [workspaceArg, outArg, ...only] = process.argv.slice(2);
if (!workspaceArg || !outArg) throw new Error("usage: theme-previews.ts <workspaceId> <outDir>");
const workspaceId: string = workspaceArg;
const outDir: string = outArg;
mkdirSync(outDir, { recursive: true });

async function paint(themeId: string) {
  const theme = AVATAR_THEMES.find((entry) => entry.id === themeId)!;
  const prompt = [
    `Call generate_image exactly ${SUBJECTS.length} times, one image per subject below, in this order, then reply with only the word "done".`,
    "Each image is a square app avatar for an AI agent. All of them must share one consistent house style so they read as a set:",
    `Style: ${theme.style.replaceAll("{accent}", PER_IMAGE_ACCENT)}`,
    "The background is opaque and fills the whole square: no transparency, no text, no letters, no watermark, no border.",
    // Alternate the accents across the samples so the preview shows each of them.
    ...SUBJECTS.map((entry, index) => {
      const accent = theme.accents?.[index % theme.accents.length];
      return `${index + 1}. ${entry.subject}${accent ? ` (accent: ${accent})` : ""}`;
    }),
  ].join("\n");
  const studio = await api.createSession(workspaceId, {
    idempotencyKey: `simple-app:theme-preview:${themeId}:${crypto.randomUUID()}`,
    reasoningEffort: "low",
    metadata: { simpleApp: { kind: "studio", themePreview: themeId } },
    memoryScope: "off",
    sandboxBackend: "none",
    agent: {
      capabilities: { from: "none", media: true },
      identity: "You are an illustrator that makes app avatars.",
    },
    initialMessage: prompt,
  } as Parameters<typeof api.createSession>[1]);
  const deadline = Date.now() + 15 * 60 * 1000;
  let ids: string[] = [];
  while (Date.now() < deadline) {
    await Bun.sleep(5000);
    const [events, session] = await Promise.all([
      api.listEvents(workspaceId, studio.id, { limit: 500 } as never),
      api.getSession(workspaceId, studio.id),
    ]);
    ids = generatedImageIds(events);
    const settled =
      session.status === "failed" ||
      session.status === "cancelled" ||
      (session.status === "idle" && !session.activeTurnId && session.lastSequence > 3);
    if (ids.length >= SUBJECTS.length || settled) break;
  }
  for (const [index, id] of ids.entries()) {
    const image = await downloadImage(workspaceId, id);
    if (image)
      writeFileSync(join(outDir, `${themeId}-${SUBJECTS[index]?.key ?? index}.png`), image.bytes);
  }
  await api.updateSessionArchive(workspaceId, studio.id, { archived: true }).catch(() => {});
  console.log(`${themeId}: ${ids.length} images (session ${studio.id})`);
}

const themes = only.length ? only : AVATAR_THEMES.map((theme) => theme.id);
await Promise.all(themes.map((id) => paint(id).catch((error) => console.error(id, error))));
