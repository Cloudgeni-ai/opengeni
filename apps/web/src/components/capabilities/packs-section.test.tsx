import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { usePacks } from "@opengeni/react";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import type {
  CapabilityPack,
  PackInstallation,
  PackInstallationPreview,
  PackUninstallPreview,
} from "@/types";
import { PackInstallationPlan, PacksSection, PackUninstallPlan } from "./packs-section";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => GlobalRegistrator.unregister());

describe("PacksSection", () => {
  test("reviews additions, configuration, and compute before install", async () => {
    const onPreviewInstall = mock(async () => installPreview());
    const rendered = await render(
      <PacksSection
        packs={packsState(null)}
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
        busyPackId={null}
        onRegister={async () => true}
        onPreviewInstall={onPreviewInstall}
        onInstall={async () => true}
        onPreviewUninstall={async () => uninstallPreview()}
        onUninstall={async () => true}
        onUnregister={async () => true}
      />,
    );
    try {
      await click(button(document, "Review install"));
      await flush();
      expect(onPreviewInstall).toHaveBeenCalledTimes(1);
      await click(button(document, "Contents"));
      expect(document.body.textContent).toContain("Compute requirement");
      expect(document.body.textContent).toContain("Configuration requirements");
      expect(document.body.textContent).toContain("Values come from an encrypted Variable Set");
    } finally {
      await rendered.unmount();
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

  test("explains shared-owner retention before uninstall", async () => {
    const onPreviewUninstall = mock(async () => uninstallPreview());
    const rendered = await render(
      <PacksSection
        packs={packsState(installation())}
        variableSets={[]}
        rigs={[]}
        busyPackId={null}
        onRegister={async () => true}
        onPreviewInstall={async () => installPreview()}
        onInstall={async () => true}
        onPreviewUninstall={onPreviewUninstall}
        onUninstall={async () => true}
        onUnregister={async () => true}
      />,
    );
    try {
      await click(button(document, "Uninstall"));
      await flush();
      expect(onPreviewUninstall).toHaveBeenCalledTimes(1);
    } finally {
      await rendered.unmount();
    }

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

function installation(): PackInstallation {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    accountId: "44444444-4444-4444-8444-444444444444",
    workspaceId: "55555555-5555-4555-8555-555555555555",
    packId: pack().id,
    status: "active",
    version: 3,
    manifestSnapshot: pack(),
    manifestDigest: "d".repeat(64),
    selectedRigId: RIG_ID,
    installedBySubjectId: "user:test",
    metadata: { variableSetId: VARIABLE_SET_ID },
    enabledAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
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

function packsState(current: PackInstallation | null): ReturnType<typeof usePacks> {
  return {
    packs: [pack()],
    installations: current ? [current] : [],
    installationFor: () => current,
    loading: false,
    error: null,
    refresh: async () => {},
    register: async () => null,
    enable: async () => null,
    previewInstallation: async () => null,
    install: async () => null,
    previewUninstall: async () => null,
    uninstall: async () => null,
    remove: async () => false,
    mutating: false,
    mutationError: null,
    clearMutationError: () => {},
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

function button(container: ParentNode, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}
