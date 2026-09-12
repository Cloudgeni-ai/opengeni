import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { ArtifactCatalogKind } from "@opengeni/contracts";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

const Cursor = z
  .object({
    version: z.literal(1),
    snapshotAt: z.string().datetime(),
    expiresAt: z.number().int().positive(),
    after: z
      .object({
        key: z.string().max(4096),
        kind: ArtifactCatalogKind,
        id: z.string().min(1).max(128),
      })
      .strict(),
  })
  .strict();
export type ArtifactCatalogCursor = z.infer<typeof Cursor>;

/** Encrypted as well as authenticated: a scan frontier may name a denied row.
 * Binding includes principal, workspace, owner context, permissions and filters.
 */
export function artifactCatalogCursorCodec(secret: string, binding: string) {
  const key = createHash("sha256").update("opengeni:artifact-catalog:v1\0").update(secret).digest();
  const aad = createHash("sha256").update(binding).digest();
  return {
    encode(value: ArtifactCatalogCursor): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(aad);
      const bytes = Buffer.concat([
        cipher.update(JSON.stringify(Cursor.parse(value)), "utf8"),
        cipher.final(),
      ]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString("base64url");
    },
    decode(value: string): ArtifactCatalogCursor {
      try {
        if (value.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
        const bytes = Buffer.from(value, "base64url");
        if (bytes.length < 29 || bytes.toString("base64url") !== value) throw new Error();
        const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
        decipher.setAAD(aad);
        decipher.setAuthTag(bytes.subarray(12, 28));
        const parsed = Cursor.parse(
          JSON.parse(
            Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"),
          ),
        );
        if (parsed.expiresAt <= Date.now() || Date.parse(parsed.snapshotAt) > Date.now() + 60_000)
          throw new Error();
        return parsed;
      } catch {
        throw new HTTPException(422, { message: "Invalid or expired artifact catalog cursor" });
      }
    },
  };
}
