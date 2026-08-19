import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import type {
  CapabilityPack,
  PackInstallation,
  PackInstallationPreview,
  PackUninstallPreview,
} from "@/types";
import {
  PackContents,
  PackDetailActions,
  PackDetailDialog,
  PackIdentity,
  PackInstallationPlan,
  PackUninstallPlan,
} from "./pack-dialogs";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => GlobalRegistrator.unregister());

// Radix portals do not mount in this DOM shim, so the dialog frame itself is
// exercised end to end by the browser acceptance spec. Here we cover the parts
// that carry the real decisions: the review that opening a Pack row triggers,
// and the plans and contents that review renders.
describe("PackDetailDialog", () => {
  test("reviews the plan as soon as the Pack row opens, with no second button", async () => {
    const onPreviewInstall = mock(async () => installPreview());
    const rendered = await render(
      <PackDetailDialog
        open
        pack={pack()}
        installation={null}
        variableSets={[{ id: VARIABLE_SET_ID, name: "Production" }]}
        rigs={[
          {
            id: RIG_ID,
            name: "Production Rig",
            image: "ghcr.io/acme/agent@sha256:abc",
            available: true,
            verified: true,
          },
        ]}
        busy={false}
        onOpenChange={() => {}}
        onPreviewInstall={onPreviewInstall}
        onInstall={async () => true}
        onPreviewUninstall={async () => uninstallPreview()}
        onUninstall={async () => true}
        onUnregister={async () => true}
      />,
    );
    try {
      await flush();
      expect(onPreviewInstall).toHaveBeenCalledTimes(1);
    } finally {
      await rendered.unmount();
    }
  });

  test("a closed Pack row reviews nothing", async () => {
    const onPreviewInstall = mock(async () => installPreview());
    const rendered = await render(
      <PackDetailDialog
        open={false}
        pack={pack()}
        installation={null}
        variableSets={[]}
        rigs={[]}
        busy={false}
        onOpenChange={() => {}}
        onPreviewInstall={onPreviewInstall}
        onInstall={async () => true}
        onPreviewUninstall={async () => uninstallPreview()}
        onUninstall={async () => true}
        onUnregister={async () => true}
      />,
    );
    try {
      await flush();
      expect(onPreviewInstall).toHaveBeenCalledTimes(0);
    } finally {
      await rendered.unmount();
    }
  });

  test("shows the reviewed additions, configuration, and compute", async () => {
    const contents = await render(<PackContents pack={pack()} />);
    try {
      expect(contents.container.textContent).toContain("Compute requirement");
      expect(contents.container.textContent).toContain("Configuration requirements");
      expect(contents.container.textContent).toContain(
        "Values come from an encrypted Variable Set",
      );
    } finally {
      await contents.unmount();
    }

    const plan = await render(<PackInstallationPlan preview={installPreview()} />);
    try {
      expect(plan.container.textContent).toContain("Ready to install");
      expect(plan.container.textContent).toContain("Pinned components");
      expect(plan.container.textContent).toContain("Terraform");
      expect(plan.container.textContent).toContain("Legacy fields will be migrated");
      expect(plan.container.textContent).toContain("Production Rig");
    } finally {
      await plan.unmount();
    }
  });

  // Two destructive, ownership-releasing verbs. Radix portals the dialog frame
  // out of this DOM shim's reach, but the footer that fires them does not have
  // to live inside it, so the wiring is proven here rather than assumed.
  test("Uninstall and Unregister reach their callbacks", async () => {
    const onUninstall = mock(() => {});
    const onUnregister = mock(() => {});
    const rendered = await render(
      <PackDetailActions
        busy={false}
        installed
        reviewing={false}
        reviewed
        hasPreview
        installReady
        installLabel="Update Pack"
        onCancel={() => {}}
        onReview={() => {}}
        onInstall={() => {}}
        onUninstall={onUninstall}
        onUnregister={onUnregister}
      />,
    );
    try {
      await act(async () => button(rendered.container, "Uninstall").click());
      expect(onUninstall).toHaveBeenCalledTimes(1);
      // Unregister is refused while the Pack is installed: releasing the
      // manifest under a live installation is the one order that cannot work.
      expect(button(rendered.container, "Unregister").disabled).toBe(true);
      expect(button(rendered.container, "Unregister").title).toContain(
        "Uninstall this Pack before unregistering",
      );
      await act(async () => button(rendered.container, "Unregister").click());
      expect(onUnregister).not.toHaveBeenCalled();
    } finally {
      await rendered.unmount();
    }

    const notInstalled = await render(
      <PackDetailActions
        busy={false}
        installed={false}
        reviewing={false}
        reviewed={false}
        hasPreview={false}
        installReady={false}
        installLabel="Review plan"
        onCancel={() => {}}
        onReview={() => {}}
        onInstall={() => {}}
        onUninstall={onUninstall}
        onUnregister={onUnregister}
      />,
    );
    try {
      // Nothing to uninstall, so the verb is absent rather than inert.
      expect(
        [...notInstalled.container.querySelectorAll("button")].map((node) =>
          node.textContent?.trim(),
        ),
      ).not.toContain("Uninstall");
      await act(async () => button(notInstalled.container, "Unregister").click());
      expect(onUnregister).toHaveBeenCalledTimes(1);
      expect(onUninstall).toHaveBeenCalledTimes(1);
    } finally {
      await notInstalled.unmount();
    }
  });

  test("names the installed version, role, category, digest, and description", async () => {
    const rendered = await render(<PackIdentity pack={pack()} installation={installation()} />);
    try {
      const text = rendered.container.textContent ?? "";
      expect(text).toContain("v2.0.0");
      expect(text).toContain("infrastructure");
      expect(text).toContain("operations");
      // The exact digest an operator compares before a repair, not a name.
      expect(text).toContain("eeeeeeeeeeee");
      expect(text).toContain("Pinned infrastructure automation capabilities.");
    } finally {
      await rendered.unmount();
    }

    const uninstalled = await render(<PackIdentity pack={pack()} installation={null} />);
    try {
      expect(uninstalled.container.textContent).toContain("v2.0.0");
      expect(uninstalled.container.textContent).not.toContain("eeeeeeeeeeee");
    } finally {
      await uninstalled.unmount();
    }
  });

  test("explains shared-owner retention before uninstall", async () => {
    const plan = await render(<PackUninstallPlan loading={false} preview={uninstallPreview()} />);
    try {
      expect(plan.container.textContent).toContain("1 shared");
      expect(plan.container.textContent).toContain("1 released");
      expect(plan.container.textContent).toContain("Retained by another Pack");
    } finally {
      await plan.unmount();
    }
  });
});

function button(container: ParentNode, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === label,
  );
  if (!found) throw new Error(`no button labelled ${label}`);
  return found as HTMLButtonElement;
}

function installation(): PackInstallation {
  return {
    id: "88888888-8888-4888-8888-888888888888",
    accountId: "99999999-9999-4999-8999-999999999999",
    workspaceId: "00000000-0000-4000-8000-000000000001",
    packId: pack().id,
    status: "active",
    version: 3,
    manifestSnapshot: pack(),
    manifestDigest: "e".repeat(64),
    selectedRigId: RIG_ID,
    installedBySubjectId: null,
    metadata: {},
    enabledAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
  };
}

const RIG_ID = "11111111-1111-4111-8111-111111111111";
const VARIABLE_SET_ID = "22222222-2222-4222-8222-222222222222";

function pack(): CapabilityPack {
  return {
    id: "infra-ops",
    name: "Infrastructure operations",
    description: "Pinned infrastructure automation capabilities.",
    role: "infrastructure",
    category: "operations",
    version: "2.0.0",
    sandboxImage: "ghcr.io/acme/agent@sha256:abc",
    skills: [
      {
        name: "release-operator",
        files: [{ path: "SKILL.md", content: "# Release operator" }],
      },
    ],
    components: [
      {
        key: "skills/terraform",
        kind: "skill",
        capabilityId: "skill:terraform",
        contentSha256: "a".repeat(64),
        required: true,
      },
    ],
    rig: { required: true, rigId: RIG_ID, requireVerified: true },
    tools: [],
    connectors: [],
    knowledge: [],
    scheduledTaskTemplates: [],
    variableSet: {
      description: "Cloud credentials",
      requiredVariables: ["CLOUD_TOKEN"],
      required: true,
    },
    metadata: {},
  };
}

function installPreview(): PackInstallationPreview {
  return {
    packId: pack().id,
    packVersion: pack().version,
    manifestDigest: "d".repeat(64),
    installationVersion: null,
    action: "install",
    ready: true,
    blockers: [],
    components: [
      {
        key: "skills/terraform",
        kind: "skill",
        capabilityId: "skill:terraform",
        required: true,
        status: "ready",
        expectedDigest: "a".repeat(64),
        actualDigest: "a".repeat(64),
        resolvedId: "66666666-6666-4666-8666-666666666666",
        label: "Terraform",
      },
      {
        key: "inline-skill/release-operator",
        kind: "inline_skill",
        capabilityId: "skill:pack:infra-ops/release-operator",
        required: true,
        status: "ready",
        expectedDigest: "b".repeat(64),
        actualDigest: "b".repeat(64),
        resolvedId: "skill:pack:infra-ops/release-operator",
        label: "release-operator",
      },
    ],
    rig: {
      required: true,
      status: "ready",
      requestedRigId: RIG_ID,
      rigId: RIG_ID,
      rigVersionId: "77777777-7777-4777-8777-777777777777",
      name: "Production Rig",
      image: "ghcr.io/acme/agent@sha256:abc",
    },
    variableSetId: VARIABLE_SET_ID,
    legacyInlineSkillCount: 1,
    legacySandboxImage: "ghcr.io/acme/agent@sha256:abc",
  };
}

function uninstallPreview(): PackUninstallPreview {
  return {
    packId: pack().id,
    installed: true,
    installationVersion: 3,
    components: [
      {
        key: "skills/terraform",
        kind: "skill",
        capabilityId: "skill:terraform",
        retainedByOtherOwners: true,
      },
      {
        key: "inline-skill/release-operator",
        kind: "inline_skill",
        capabilityId: "skill:pack:infra-ops/release-operator",
        retainedByOtherOwners: false,
      },
    ],
  };
}

async function render(element: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
      document.body.replaceChildren();
    },
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
