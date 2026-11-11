import { useEffect, useRef, useState } from "react";
import { BotIcon } from "lucide-react";
import { teamsApi } from "@opengeni/sdk/teams";
import { useAppContext } from "@opengeni/react/app/app-context";
import { hasWorkspacePermission } from "@opengeni/react/app/lib/permissions";
import { FormPage } from "@opengeni/react/ui/form-dialog";
import { Field, FieldStack } from "@opengeni/react/ui/field";
import { Select } from "@opengeni/react/ui/select";
import { LogoTile } from "@opengeni/react/ui/logo-tile";
import { Button } from "@opengeni/react/ui/button";
import { EmptyState } from "@opengeni/react/ui/empty-state";
import { ConsentFrame } from "@/components/organization-access/mcp-consent-page";
import {
  teamsFragmentToken,
  clearTeamsFragment,
  clearPendingTeamsSetup,
  clearTeamsMicrosoftReturn,
  clearPendingTeamsLink,
  readPendingTeamsLink,
  readPendingTeamsSetup,
  savePendingTeamsSetup,
  teamsMicrosoftSignInPurpose,
  teamsMicrosoftFailureText,
  teamsErrorText,
  teamsLinkSignInRefused,
  teamsMicrosoftReturn,
  teamsOwnAccountLinkedElsewhere,
  teamsRouteMissing,
  type TeamsMicrosoftReturn,
  type TeamsPendingLink,
  type TeamsPendingSetup,
} from "@/lib/teams-connect";

type Arrival =
  | { kind: "setup"; pending: TeamsPendingSetup | null; microsoft: TeamsMicrosoftReturn | null }
  | { kind: "link"; pending: TeamsPendingLink | null; microsoft: TeamsMicrosoftReturn };

/**
 * A return from Microsoft sign-in restores this tab's pending setup, or its
 * pending account link when the sign-in was for one. Reads only.
 */
function readArrival(): Arrival {
  const microsoft = teamsMicrosoftReturn(window.location.search);
  if (!microsoft) return { kind: "setup", pending: null, microsoft: null };
  const purpose = teamsMicrosoftSignInPurpose(microsoft.state);
  const setup = purpose === "link" ? null : readPendingTeamsSetup();
  const link = purpose === "setup" ? null : readPendingTeamsLink();
  return purpose === "link" || (link && !setup)
    ? { kind: "link", pending: link, microsoft }
    : { kind: "setup", pending: setup, microsoft };
}

export function TeamsConnectRoute() {
  const [arrival] = useState(readArrival);
  return arrival.kind === "link" ? (
    <TeamsLinkReturn pending={arrival.pending} microsoft={arrival.microsoft} />
  ) : (
    <TeamsSetupPage arrival={arrival} />
  );
}

/**
 * Finishes an account link after the Microsoft sign-in that proves the person
 * is the Teams user the link names. The API refuses a different account.
 */
function TeamsLinkReturn({
  pending,
  microsoft,
}: {
  pending: TeamsPendingLink | null;
  microsoft: TeamsMicrosoftReturn;
}) {
  const { client } = useAppContext();
  const [result, setResult] = useState<
    { kind: "linking" } | { kind: "linked" } | { kind: "failed"; message: string; retry: boolean }
  >(() =>
    microsoft.kind === "failed"
      ? { kind: "failed", message: teamsMicrosoftFailureText(microsoft, "link"), retry: true }
      : pending
        ? { kind: "linking" }
        : {
            kind: "failed",
            message: "This link expired. Message Opengeni in Teams to get a new link.",
            retry: false,
          },
  );
  const finished = useRef(false);

  useEffect(() => {
    // The code and pending link are single-use; neither survives a reload.
    clearTeamsMicrosoftReturn();
    clearPendingTeamsLink();
    if (microsoft.kind !== "signed_in" || !pending || finished.current) return;
    finished.current = true;
    void teamsApi(client, pending.workspaceId)
      .linkAccount(pending.linkToken, { code: microsoft.code, state: microsoft.state })
      .then(() => setResult({ kind: "linked" }))
      .catch((caught) =>
        setResult({
          kind: "failed",
          message: teamsErrorText(
            caught,
            "Microsoft sign-in couldn't be verified. Open the link from Teams again.",
          ),
          retry: teamsLinkSignInRefused(caught),
        }),
      );
  }, [client, microsoft, pending]);

  const plugins = pending ? `/workspaces/${encodeURIComponent(pending.workspaceId)}/plugins` : null;
  if (result.kind === "linking")
    return (
      <ConsentFrame>
        <EmptyState
          variant="page"
          icon={<BotIcon />}
          title="Linking your Teams account…"
          description="Checking your Microsoft sign-in."
        />
      </ConsentFrame>
    );
  if (result.kind === "linked")
    return (
      <ConsentFrame>
        <EmptyState
          variant="page"
          icon={<BotIcon />}
          title="Teams account linked"
          description="Return to Teams to continue."
          action={
            <div className="flex flex-col items-center gap-3">
              <Button onClick={() => window.location.assign("https://teams.microsoft.com")}>
                Return to Teams
              </Button>
              {plugins ? (
                <a className="text-sm text-fg-muted underline underline-offset-4" href={plugins}>
                  Manage connection
                </a>
              ) : null}
            </div>
          }
        />
      </ConsentFrame>
    );
  return (
    <ConsentFrame>
      <EmptyState
        variant="page"
        icon={<BotIcon />}
        title="Couldn't link your Teams account"
        description={result.message}
        action={
          pending && plugins && result.retry ? (
            <Button
              onClick={() =>
                window.location.assign(
                  `${plugins}#${new URLSearchParams({ teams_link: pending.linkToken })}`,
                )
              }
            >
              Try again
            </Button>
          ) : (
            <Button onClick={() => window.location.assign("https://teams.microsoft.com")}>
              Open Teams
            </Button>
          )
        }
      />
    </ConsentFrame>
  );
}

/**
 * The signed Teams challenge is submitted only after the human chooses a
 * workspace. Unless the operator approved this Teams identity, the person then
 * signs in with Microsoft as a tenant administrator before the bot connects.
 */
function TeamsSetupPage({ arrival }: { arrival: Extract<Arrival, { kind: "setup" }> }) {
  const { client, workspaces, accessContext } = useAppContext();
  const [token, setToken] = useState(
    () => arrival.pending?.setupToken ?? teamsFragmentToken(window.location.hash, "teams_setup"),
  );
  const choices = workspaces.filter(
    (workspace) =>
      workspace.kind === "shared" &&
      hasWorkspacePermission(accessContext, workspace.id, "workspace:admin"),
  );
  const [workspaceId, setWorkspaceId] = useState(
    () => arrival.pending?.workspaceId ?? (choices.length === 1 ? choices[0]!.id : ""),
  );
  const [error, setError] = useState<string | null>(() =>
    arrival.microsoft?.kind === "failed"
      ? teamsMicrosoftFailureText(arrival.microsoft)
      : arrival.microsoft && !arrival.pending
        ? "This setup expired. Message Opengeni in Teams to get a new setup link."
        : null,
  );
  // The workspace where the signed-in account is linked to another Teams
  // account; connecting there again replaces that link once setup succeeds.
  const [unlinkIn, setUnlinkIn] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [finishing, setFinishing] = useState(
    arrival.microsoft?.kind === "signed_in" && Boolean(arrival.pending),
  );
  const finished = useRef(false);

  useEffect(() => {
    if (!arrival.microsoft) return;
    // The code and pending setup are single-use; neither survives a reload.
    clearTeamsMicrosoftReturn();
    clearPendingTeamsSetup();
    const signedIn = arrival.microsoft.kind === "signed_in" ? arrival.microsoft : null;
    if (!signedIn || !arrival.pending || finished.current) return;
    finished.current = true;
    const { setupToken, workspaceId: chosen, replaceOwnLink } = arrival.pending;
    void teamsApi(client, chosen)
      .installBot(
        setupToken,
        { code: signedIn.code, state: signedIn.state },
        { replaceOwnLink: Boolean(replaceOwnLink) },
      )
      .then(() => {
        clearTeamsFragment("teams_setup");
        setToken(null);
        setConnected(true);
      })
      .catch((caught) => {
        setError(teamsErrorText(caught, "Microsoft sign-in couldn't be verified. Try again."));
        setUnlinkIn(teamsOwnAccountLinkedElsewhere(caught) ? chosen : null);
      })
      .finally(() => setFinishing(false));
  }, [arrival, client]);

  useEffect(() => {
    const captureSetup = () => {
      const next = teamsFragmentToken(window.location.hash, "teams_setup");
      // Clearing a consumed proof must not replace the success screen.
      if (!next) return;
      setToken(next);
      setConnected(false);
      setError(null);
      setUnlinkIn(null);
    };
    window.addEventListener("hashchange", captureSetup);
    return () => window.removeEventListener("hashchange", captureSetup);
  }, []);

  if (finishing)
    return (
      <ConsentFrame>
        <EmptyState
          variant="page"
          icon={<BotIcon />}
          title="Connecting Teams…"
          description="Checking your Microsoft sign-in."
        />
      </ConsentFrame>
    );

  if (connected)
    return (
      <ConsentFrame>
        <EmptyState
          variant="page"
          icon={<BotIcon />}
          title="Teams is connected"
          description="Your account is linked. Return to Teams to start a chat."
          action={
            <div className="flex flex-col items-center gap-3">
              <Button onClick={() => window.location.assign("https://teams.microsoft.com")}>
                Return to Teams
              </Button>
              <a
                className="text-sm text-fg-muted underline underline-offset-4"
                href={`/workspaces/${encodeURIComponent(workspaceId)}/plugins`}
              >
                Manage connection
              </a>
            </div>
          }
        />
      </ConsentFrame>
    );

  if (!token)
    return (
      <ConsentFrame>
        <EmptyState
          variant="page"
          icon={<BotIcon />}
          title="Open the setup link from Teams"
          description="Message Opengeni in Teams to get a new setup link."
          action={
            <Button onClick={() => window.location.assign("https://teams.microsoft.com")}>
              Open Teams
            </Button>
          }
        />
      </ConsentFrame>
    );

  return (
    <ConsentFrame>
      <FormPage
        leading={<LogoTile icon={<BotIcon />} />}
        title="Connect Teams to Opengeni"
        description="Choose where Opengeni will work on requests from Teams."
        submitLabel={unlinkIn === workspaceId ? "Unlink and connect" : "Connect workspace"}
        submitDisabled={!choices.some((workspace) => workspace.id === workspaceId)}
        pendingLabel="Connecting…"
        cancelLabel={null}
        onSubmit={async () => {
          if (!choices.some((workspace) => workspace.id === workspaceId)) {
            setError("Choose a workspace you administer.");
            return false;
          }
          setError(null);
          const replaceOwnLink = unlinkIn === workspaceId;
          try {
            const api = teamsApi(client, workspaceId);
            const { authorizationUrl } = await api.startMicrosoftSignIn(token).catch((caught) => {
              // An API without self-serve setup keeps the operator-approved flow.
              if (teamsRouteMissing(caught)) return { authorizationUrl: null };
              throw caught;
            });
            if (authorizationUrl) {
              savePendingTeamsSetup({
                setupToken: token,
                workspaceId,
                ...(replaceOwnLink ? { replaceOwnLink: true as const } : {}),
              });
              window.location.assign(authorizationUrl);
              return false;
            }
            await api.installBot(token, undefined, { replaceOwnLink });
            clearTeamsFragment("teams_setup");
            setConnected(true);
          } catch (caught) {
            setError(
              teamsErrorText(
                caught,
                "This setup link may have expired. Request a new link in Teams.",
              ),
            );
            setUnlinkIn(teamsOwnAccountLinkedElsewhere(caught) ? workspaceId : null);
          }
          return false;
        }}
      >
        <FieldStack>
          {choices.length ? (
            <Field label="Workspace" id="teams-workspace">
              <Select
                id="teams-workspace"
                value={workspaceId}
                onChange={(event) => {
                  setWorkspaceId(event.target.value);
                  setError(null);
                  setUnlinkIn(null);
                }}
              >
                <option value="">Choose a workspace</option>
                {choices.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <p className="text-sm text-fg-muted">
              No workspaces available. Ask your organization owner for workspace admin access, then
              reopen this link.
            </p>
          )}
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          <p className="text-sm text-fg-muted">
            You may be asked to sign in to Microsoft as a Global Administrator or Teams
            Administrator. This also links your Teams account so you can start work right away.
          </p>
        </FieldStack>
      </FormPage>
    </ConsentFrame>
  );
}
