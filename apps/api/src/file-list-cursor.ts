import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

const Cursor = z
  .object({
    version: z.literal(1),
    after: z.string().min(1).max(2048),
    expiresAt: z.number().int().positive(),
  })
  .strict();

/** The scan frontier may name a host-denied File, so encrypt and bind it. */
export function fileListCursorCodec(secret: string, binding: string) {
  const key = createHash("sha256").update("opengeni:file-list:v1\0").update(secret).digest();
  const aad = createHash("sha256").update(binding).digest();
  return {
    encode(after: string): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(aad);
      const bytes = Buffer.concat([
        cipher.update(
          JSON.stringify(Cursor.parse({ version: 1, after, expiresAt: Date.now() + 60 * 60_000 })),
          "utf8",
        ),
        cipher.final(),
      ]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString("base64url");
    },
    decode(value: string): string {
      try {
        if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
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
        if (parsed.expiresAt <= Date.now()) throw new Error();
        return parsed.after;
      } catch {
        throw new HTTPException(422, { message: "Invalid or expired file cursor" });
      }
    },
  };
}
