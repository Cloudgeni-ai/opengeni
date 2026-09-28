import { describe, expect, test } from "bun:test";

const routeSource = await Bun.file(`${import.meta.dir}/routes/org-settings.tsx`).text();
// Organization settings pages: the shared directory (reads, mutations and
// their operation lanes) and the People, Workspaces and Security pages.
const directorySource = await Bun.file(
  `${import.meta.dir}/components/organization/organization-directory.tsx`,
).text();
const peopleSource = await Bun.file(
  `${import.meta.dir}/components/organization/people-page.tsx`,
).text();
const workspacesSource = await Bun.file(
  `${import.meta.dir}/components/organization/workspaces-page.tsx`,
).text();
const securitySource = await Bun.file(
  `${import.meta.dir}/components/organization/security-page.tsx`,
).text();
const adminSource = [directorySource, peopleSource, workspacesSource, securitySource].join("\n");
const peopleModelSource = await Bun.file(
  `${import.meta.dir}/components/organization/organization-people-model.ts`,
).text();
const identitySource = await Bun.file(
  `${import.meta.dir}/components/organization/identity-page.tsx`,
).text();
// Accepting incoming invitations moved to the rail/account menu.
const incomingInvitationsSource = await Bun.file(
  `${import.meta.dir}/components/organization-invitations.tsx`,
).text();
const frameSource = await Bun.file(
  `${import.meta.dir}/components/settings/settings-sidebar.tsx`,
).text();
const settingsNavSource = await Bun.file(
  `${import.meta.dir}/components/ui/settings-nav.tsx`,
).text();
const shellSource = await Bun.file(
  `${import.meta.dir}/components/settings/organization-settings-shell.tsx`,
).text();
const apiKeySource = await Bun.file(
  `${import.meta.dir}/components/organization-api-keys-section.tsx`,
).text();
const recoverySource = await Bun.file(
  `${import.meta.dir}/components/organization-recovery.tsx`,
).text();
const organizationCodexSource = await Bun.file(
  `${import.meta.dir}/components/organization-codex-subscriptions.tsx`,
).text();
const organizationModelProviderSource = await Bun.file(
  `${import.meta.dir}/components/organization-model-provider-connection.tsx`,
).text();
const workspaceCodexSource = await Bun.file(
  `${import.meta.dir}/components/models/codex-models.tsx`,
).text();
const organizationModelsSource = await Bun.file(
  `${import.meta.dir}/components/models/organization-models-page.tsx`,
).text();
const providerPageSource = await Bun.file(
  `${import.meta.dir}/components/ai-gateway-connection.tsx`,
).text();
const normalizedRecoverySource = recoverySource.replace(/\s+/gu, " ");
const workspaceSettingsSource = await Bun.file(
  `${import.meta.dir}/routes/workspace-settings.tsx`,
).text();
const workspaceMembersSource = await Bun.file(
  `${import.meta.dir}/routes/workspace-members-section.tsx`,
).text();
const tenancyDocs = await Bun.file(
  `${import.meta.dir}/../../../docs/organization-tenancy.md`,
).text();

describe("organization administration surface", () => {
  test("manages Gateway and OpenRouter as peer organization BYOK providers", () => {
    expect(routeSource).toContain("<OrganizationModelsPage");
    expect(organizationModelsSource).toContain('providerKind: "vercel_gateway"');
    expect(organizationModelsSource).toContain('providerKind: "openrouter"');
    for (const method of [
      "getOrganizationModelProviderConnection",
      "upsertOrganizationModelProviderConnection",
      "revokeOrganizationModelProviderConnection",
      "listOrganizationProviderCustomModels",
      "createOrganizationProviderCustomModel",
      "deleteOrganizationProviderCustomModel",
    ]) {
      expect(organizationModelProviderSource).toContain(`client.${method}(`);
    }
    // Keys are write-only secret fields; disconnect and model removal both confirm first.
    expect(providerPageSource).toContain("<SecretInput");
    expect(organizationModelProviderSource).not.toContain("localStorage");
    expect(organizationModelProviderSource).toContain("in shared workspaces");
    expect(providerPageSource).toContain("<DestructiveConfirm");
    expect(providerPageSource).toContain("<ConfirmDialog");
  });

  test("routes accessible general, people, workspaces, identity, security, developer, and billing sections", () => {
    expect(routeSource).toContain("<OrganizationSettingsShell");
    expect(shellSource).toContain('label="Organization settings"');
    // The SettingsShell names the settings rail from `label`; NavItem marks the current page.
    expect(frameSource).toContain("aria-label={label}");
    expect(settingsNavSource).toContain('aria-current={active && !disabled ? "page" : undefined}');
    for (const section of [
      "general",
      "people",
      "workspaces",
      "models",
      "integrations",
      "identity",
      "billing",
      "developer",
      "security",
    ]) {
      expect(shellSource).toContain(`id: "${section}"`);
    }
    // Pages this person can't use are hidden from the nav.
    expect(shellSource).toContain("visibleSections.has(item.id)");
    expect(routeSource).toContain('section === "identity"');
    expect(routeSource).toContain("<OrganizationIdentityPage");
    expect(routeSource).toContain('section === "integrations"');
    expect(routeSource).toContain("<OrganizationIntegrationsSection");
    // Retention, private chats and recovery live on the Security & data page.
    expect(routeSource).toContain('section === "security"');
    expect(routeSource).toContain("<OrganizationSecurityPage");
    expect(securitySource).toContain("<OrganizationRecoverySection");
    expect(securitySource).toContain("<RetentionRow");
    expect(identitySource).toContain("<OrganizationKnowledgePrompt");
    expect(identitySource).toContain("<AgentChangesSection");
    expect(routeSource).toContain('context.clientConfig.productAccessMode === "local"');
    expect(routeSource).toContain("organizationAdministratorSession");
    expect(routeSource).toContain("singleUser={singleUser}");
    expect(routeSource).toContain('actorRole === "owner" || actorRole === "admin"');
    // Models is shown only to organization administrators.
    expect(routeSource).toMatch(/if \(administrator\) \{[^}]*visible\.add\("models"\)/u);
    expect(organizationCodexSource).toContain("setLoadError(");
    expect(organizationModelsSource).toContain("<ErrorMessage");
    expect(organizationModelsSource).toContain("Try again");
    // Workspace Codex: no source control; one line says which pool new work uses, with
    // "Use automatically" for a saved explicit choice. The only link to organization
    // settings is on a shared account's page, for org admins.
    expect(workspaceCodexSource).not.toContain('label="Subscriptions from"');
    expect(workspaceCodexSource).toContain("export function CodexPoolNotice");
    expect(workspaceCodexSource).toContain("Use automatically");
    expect(workspaceCodexSource).toContain("Manage in organization settings");
    expect(workspaceCodexSource).toContain("manageInOrganization");
    expect(routeSource).toContain("canManageOrganizationKnowledge");
    expect(routeSource).toContain('accountGrant?.role === "owner"');
    expect(routeSource).toContain('"account:admin"');
    expect(identitySource).toContain("client.getCompanyProfileAgentPolicy(");
    expect(identitySource).toContain("client.updateCompanyProfileAgentPolicy(");
    expect(identitySource).toContain('label: "Automatic"');
    expect(identitySource).toContain("Organization identity is read-only for you");
    expect(recoverySource).toContain("overview.eligibleMembers");
    expect(recoverySource).not.toContain("listOrganizationAdministrationMembers");
    // Recovery names exactly what it grants (ownership, nothing else) and why it's unavailable.
    expect(normalizedRecoverySource).toContain(
      "Makes this member an owner after two contacts approve and seven days pass. Nothing else changes.",
    );
    expect(normalizedRecoverySource).toContain('overview.availability === "recovery_unavailable"');
    expect(normalizedRecoverySource).toContain("unavailableReasonCopy(overview.unavailableReason)");
    expect(normalizedRecoverySource).toContain("An owner has to choose new contacts.");
    expect(workspaceSettingsSource).toContain('import("./workspace-members-section")');
    expect(workspaceMembersSource).toContain("client.listWorkspaceMemberCandidates");
    expect(workspaceMembersSource).toContain("Search by name or email");
    expect(workspaceMembersSource).toContain("Add to workspace");
  });

  test("wires organization API keys and keeps billing usage account-wide", () => {
    expect(routeSource).toContain('section === "developer"');
    expect(routeSource).toContain("<LazyOrganizationApiKeysSection");
    for (const method of [
      "listOrganizationApiKeys",
      "createOrganizationApiKey",
      "deleteOrganizationApiKey",
    ]) {
      expect(routeSource).toContain(`client.${method}(`);
    }
    expect(routeSource).not.toContain("permissions: requestedPermissions");
    expect(apiKeySource).toContain(
      "Server credentials that create and run every shared workspace, never Personal ones.",
    );
    expect(apiKeySource).toContain("It can't open Personal workspaces or read secret values.");
    expect(apiKeySource).toContain('title="API key created"');
    expect(apiKeySource).not.toContain("fixedPermissions");
    expect(apiKeySource).not.toContain('"workspace:read"');
    expect(apiKeySource).toContain('aria-live="polite"');
    expect(apiKeySource).toContain("props.deleteApiKey(apiKey.id)");
    expect(routeSource).not.toContain("workspaceId: props.workspaceId");
  });

  test("uses only lifecycle APIs and never links a member personal workspace", () => {
    for (const method of [
      "listOrganizationAdministrationMembers",
      "listOrganizationInvitationsForOrganization",
      "createOrganizationInvitation",
      "revokeOrganizationInvitation",
      "updateOrganizationMember",
      "updateOrganizationWorkspace",
      "putOrganizationWorkspaceMember",
      "revokeOrganizationWorkspaceMember",
      "getOrganizationRetentionPolicy",
      "updateOrganizationRetentionPolicy",
    ]) {
      expect(adminSource).toContain(`.${method}(`);
    }
    // Accepting incoming invitations moved out of Organization settings to the
    // rail/account menu (components/organization-invitations.tsx).
    expect(adminSource).not.toContain(".acceptOrganizationInvitation(");
    for (const method of ["listOrganizationInvitations", "acceptOrganizationInvitation"]) {
      expect(incomingInvitationsSource).toContain(`.${method}(`);
    }
    for (const helper of [
      "getOrganizationPrivateSessionSettings",
      "updateOrganizationPrivateSessionSettings",
    ]) {
      expect(adminSource).toContain(`${helper}(`);
    }
    expect(adminSource).not.toContain("personalWorkspaceId");
    expect(peopleModelSource).toContain("member.name?.trim() || member.email");
    expect(peopleSource).toContain("memberName(member)");
    // Invite people is its own page; access is one role per shared workspace.
    expect(peopleSource).toContain('title="Invite people"');
    expect(peopleSource).toContain('title="Workspace access"');
    expect(peopleSource).toContain("One role per shared workspace.");
    expect(peopleSource).toContain('label="Personal workspace"');
    expect(peopleSource).toContain(
      "Nobody else can open it, including owners and\n        admins.",
    );
    expect(adminSource).not.toContain(".addWorkspaceMember(");
    expect(adminSource).not.toContain(".removeWorkspaceMember(");
    expect(adminSource).toContain("await onAuthorityChanged()");
  });

  test("names destructive consequences through the DestructiveConfirm primitive", () => {
    expect(peopleSource).toContain("<DestructiveConfirm");
    expect(peopleSource).toContain("consequences={[");
    // Suspending pauses organization access, and shared-workspace access is not restored.
    expect(peopleSource).toContain("can't sign in to ${organizationName} until you restore");
    expect(peopleSource).toContain("is removed. Restoring doesn't bring it back.");
    // Removing is permanent and type-to-confirm.
    expect(peopleSource).toContain('variant="type-to-confirm"');
    expect(peopleSource).toContain("can never be invited to ${organizationName} again.");
    // Keyboard focus restoration is owned by the DestructiveConfirm primitive
    // (Radix dialog returns focus to the trigger), so pages no longer pass restoreFocusRef.
    expect(incomingInvitationsSource).toContain('aria-live="polite"');
    expect(incomingInvitationsSource).toContain(
      "disabled={controller.loading || controller.acceptingInvitationId !== null}",
    );
  });

  test("handles CAS conflicts by refreshing without replaying the mutation", () => {
    expect(adminSource.match(/isOrganizationConflict\(\w+\)/g)?.length).toBeGreaterThanOrEqual(6);
    // Each conflict refreshes the authoritative state, then surfaces the error instead of retrying.
    expect(
      directorySource.match(/isOrganizationConflict\(error\) && ownsIdentity\(\)\) await/g)?.length,
    ).toBeGreaterThanOrEqual(6);
    expect(securitySource).toContain("if (isOrganizationConflict(saveError)) await load();");
    expect(securitySource).toContain("Someone else changed this policy. Check it and try again.");
    expect(peopleSource).toContain("await directory.retryInvitation(invitation)");
    expect(peopleSource).toContain("onSelect={() => void actions.resend(invitation)}");
    expect(adminSource.match(/retryOrganizationUserSetupDelivery\(/g)?.length).toBe(1);
    // A conflicted invitation accept refreshes the list and drops its operation id.
    expect(incomingInvitationsSource).toContain("if (isOrganizationConflict(caught)) {");
    expect(incomingInvitationsSource).toContain("operationIds.current.delete(invitation.id);");
  });

  test("wires reads and mutations to independent lanes and invalidates on unmount", () => {
    for (const resource of ["members", "admin-invitations"]) {
      expect(directorySource).toContain(`claim("${resource}", "read")`);
      expect(directorySource).toContain(`claim("${resource}", "mutation")`);
    }
    // Private chats and retention each claim their own read and mutation lanes.
    expect(securitySource).toContain('useOwnedOperations(identity, "private-sessions")');
    expect(securitySource).toContain('useOwnedOperations(identity, "retention")');
    expect(securitySource).toContain('claim("read")');
    expect(securitySource).toContain('claim("mutation")');
    // Incoming invitations fence reads by client and sequence.
    expect(incomingInvitationsSource).toContain(
      "activeClient.current !== acceptedClient || readSequence.current !== sequence",
    );
    expect(adminSource.match(/identityRef\.current = null/g)?.length).toBeGreaterThanOrEqual(2);
    expect(adminSource.match(/identityRef\.current = identity/g)?.length).toBeGreaterThanOrEqual(4);
    expect(adminSource.match(/active\.clear\(\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(peopleSource).toContain("disabled={directory.invitations.loading}");
  });

  test("documents the bounded organization and workspace control plane", () => {
    expect(tenancyDocs).toContain("bounded organization\nadministration surface");
    expect(tenancyDocs).toContain("reads and mutations use independent operation lanes");
    expect(tenancyDocs).toContain("The lifecycle therefore **adopts** that exact\naccount");
    expect(tenancyDocs).toContain(
      "durable email\ndelivery outcome/retry reconciliation are active",
    );
    expect(tenancyDocs).not.toContain(
      "This phase has no durable delivery outcome, retry, or reconciliation\nstate",
    );
    expect(tenancyDocs).not.toContain(
      "Durable email delivery outcome/retry reconciliation and automatic scheduling",
    );
    expect(tenancyDocs).not.toContain("Provider email delivery remains a\nnon-goal");
    expect(tenancyDocs).not.toContain("- provider invitation email delivery;");
    expect(tenancyDocs).not.toContain(
      "no organization membership, fallback\naccount, or bound invitation",
    );
    expect(tenancyDocs).toContain("0332_organization_shared_workspace_control_plane.sql");
    expect(tenancyDocs).not.toContain("member-management\nUI remain deferred");
  });
});
