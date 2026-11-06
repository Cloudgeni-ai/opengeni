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
import { userErrorText } from "@opengeni/react/ui/api-error";
import { ConsentFrame } from "@/components/organization-access/mcp-consent-page";
import {
  teamsFragmentToken,
  clearTeamsFragment,
  clearPendingTeamsSetup,
  clearTeamsMicrosoftReturn,
  readPendingTeamsSetup,
  savePendingTeamsSetup,
  teamsMicrosoftFailureText,
  teamsMicrosoftReturn,
  teamsRouteMissing,
  type TeamsMicrosoftReturn,
  type TeamsPendingSetup,
} from "@/lib/teams-connect";

type Arrival = { pending: TeamsPendingSetup | null; microsoft: TeamsMicrosoftReturn | null };

/** A return from Microsoft sign-in restores this tab's pending setup. Reads only. */
function readArrival(): Arrival {
  const microsoft = teamsMicrosoftReturn(window.location.search);
  return microsoft
    ? { pending: readPendingTeamsSetup(), microsoft }
    : { pending: null, microsoft: null };
}

/**
 * The signed Teams challenge is submitted only after the human chooses a
 * workspace. Unless the operator approved this Teams identity, the person then
 * signs in with Microsoft as a tenant administrator before the bot connects.
 */
export function TeamsConnectRoute() {
  const { client, workspaces, accessContext } = useAppContext();
  const [arrival] = useState(readArrival);
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
    const { setupToken, workspaceId: chosen } = arrival.pending;
    void teamsApi(client, chosen)
      .installBot(setupToken, { code: signedIn.code, state: signedIn.state })
      .then(() => {
        clearTeamsFragment("teams_setup");
        setToken(null);
        setConnected(true);
      })
      .catch((caught) =>
        setError(userErrorText(caught, "Microsoft sign-in couldn't be verified. Try again.")),
      )
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
        submitLabel="Connect workspace"
        submitDisabled={!choices.some((workspace) => workspace.id === workspaceId)}
        pendingLabel="Connecting…"
        cancelLabel={null}
        onSubmit={async () => {
          if (!choices.some((workspace) => workspace.id === workspaceId)) {
            setError("Choose a workspace you administer.");
            return false;
          }
          setError(null);
          try {
            const api = teamsApi(client, workspaceId);
            const { authorizationUrl } = await api.startMicrosoftSignIn(token).catch((caught) => {
              // An API without self-serve setup keeps the operator-approved flow.
              if (teamsRouteMissing(caught)) return { authorizationUrl: null };
              throw caught;
            });
            if (authorizationUrl) {
              savePendingTeamsSetup({ setupToken: token, workspaceId });
              window.location.assign(authorizationUrl);
              return false;
            }
            await api.installBot(token);
            clearTeamsFragment("teams_setup");
            setConnected(true);
          } catch (caught) {
            setError(
              userErrorText(
                caught,
                "This setup link may have expired. Request a new link in Teams.",
              ),
            );
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
