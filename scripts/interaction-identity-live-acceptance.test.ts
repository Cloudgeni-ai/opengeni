import { describe, expect, test } from "bun:test";

const acceptancePath = new URL("./interaction-identity-live-acceptance.ts", import.meta.url);
const packagePath = new URL("../package.json", import.meta.url);

describe("interaction identity live endpoint authority", () => {
  test("uses the stack's canonical sandbox object endpoint without private tunnel discovery", async () => {
    const source = await Bun.file(acceptancePath).text();
    const packageJson = (await Bun.file(packagePath).json()) as {
      scripts?: Record<string, string>;
    };
    const command = packageJson.scripts?.["acceptance:interaction-identity-live"] ?? "";

    expect(command).toContain(". ./.env.runtime");
    expect(command).toContain("bun scripts/interaction-identity-live-acceptance.ts");
    expect(source).toContain('requiredEnv("OPENGENI_OBJECT_STORAGE_SANDBOX_ENDPOINT")');
    expect(source).not.toContain("OPENGENI_IDENTITY_ACCEPTANCE_FIXTURE_ENDPOINT");
    expect(source).not.toContain("127.0.0.1:4040");
    expect(source).not.toContain("ngrok");
  });
});
