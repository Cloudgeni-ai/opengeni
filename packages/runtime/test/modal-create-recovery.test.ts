import { expect, test } from "bun:test";
import { testSettings } from "@opengeni/testing";
import {
  findModalProviderCreateReceipt,
  terminateModalSandboxById,
} from "../src/sandbox/providers/modal";

const settings = testSettings({ modalEnvironment: "fixture" });
const operationId = "11111111-1111-4111-8111-111111111111";
const attempt = {
  operationId,
  appId: "ap-fixture",
  imageId: "im-fixture",
  providerName: `opengeni-create-${operationId}`,
  providerBindingKey: JSON.stringify({
    version: 1,
    serverUrl: "https://api.modal.test",
    workspaceName: "fixture",
    environment: "fixture",
  }),
};
const info = () => ({
  id: "sb-fixture",
  appId: attempt.appId,
  imageId: attempt.imageId,
  name: attempt.providerName,
  createdAt: 100,
  tags: [{ tagName: "opengeni_provider_create_operation_id", tagValue: operationId }],
});
function fixture(pages: unknown[][], workspaceName = "fixture") {
  const calls: any[] = [];
  let closed = false;
  return {
    calls,
    isClosed: () => closed,
    factory: async () =>
      ({
        profile: { serverUrl: "https://api.modal.test" },
        environmentName: () => "fixture",
        cpClient: {
          workspaceNameLookup: async () => ({ workspaceName }),
          sandboxList: async (input: any) => {
            calls.push(input);
            return { sandboxes: pages.shift() ?? [] };
          },
        },
        close: () => {
          closed = true;
        },
      }) as never,
  };
}
test("positive recovery includes finished instances and binds every provider identity", async () => {
  const f = fixture([[info()], []]);
  expect(await findModalProviderCreateReceipt(settings, attempt, f.factory)).toBe("sb-fixture");
  expect(f.calls).toHaveLength(2);
  expect(f.calls[0].includeFinished).toBe(true);
  expect(f.calls[0].appId).toBe(attempt.appId);
  expect(f.calls[1].beforeTimestamp).toBe(100);
  expect(f.isClosed()).toBe(true);
});
test("absence keeps the operation unresolved", async () => {
  const f = fixture([[]]);
  expect(await findModalProviderCreateReceipt(settings, attempt, f.factory)).toBeNull();
  expect(f.isClosed()).toBe(true);
});
test("different credential workspace refuses provider discovery", async () => {
  const f = fixture([[info()]], "other");
  await expect(findModalProviderCreateReceipt(settings, attempt, f.factory)).rejects.toThrow(
    "different authenticated namespace",
  );
  expect(f.calls).toHaveLength(0);
  expect(f.isClosed()).toBe(true);
});
for (const key of ["id", "appId", "imageId", "name", "tags"] as const) {
  test(`inconsistent ${key} never attributes a receipt`, async () => {
    const row = { ...info(), [key]: key === "tags" ? [] : "wrong" };
    const f = fixture([[row], []]);
    await expect(findModalProviderCreateReceipt(settings, attempt, f.factory)).rejects.toThrow(
      "inconsistent",
    );
    expect(f.isClosed()).toBe(true);
  });
}
test("duplicate physical ids preserve the fence", async () => {
  const f = fixture([[info(), { ...info(), id: "sb-other" }], []]);
  await expect(findModalProviderCreateReceipt(settings, attempt, f.factory)).rejects.toThrow(
    "ambiguous",
  );
});
test("nonadvancing pagination cannot certify uniqueness", async () => {
  const f = fixture([[info()], [info()]]);
  await expect(findModalProviderCreateReceipt(settings, attempt, f.factory)).rejects.toThrow(
    "did not advance",
  );
});

test("cleanup rejects rotated provider credentials before any sandbox lookup", async () => {
  const f = fixture([], "other");
  await expect(
    terminateModalSandboxById(settings, "sb-fixture", f.factory, attempt.providerBindingKey),
  ).rejects.toThrow("different authenticated namespace");
  expect(f.isClosed()).toBe(true);
});
