import type { SiteAuthAuthorizeRequest, SiteAuthAuthorizeResponse } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { GlobeIcon, LockKeyholeIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { ConsentFrame } from "@/components/organization-access/mcp-consent-page";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FormPage } from "@/components/ui/form-dialog";
import { LogoTile } from "@/components/ui/logo-tile";
import { Notice } from "@/components/ui/notice";
import { useAppContext } from "@/context";
import { apiErrorFacts, userErrorText } from "@/lib/api-error";
import { useNativeSignInContext } from "@/lib/native-sign-in-context";
import {
  safeSiteRedirect,
  siteAuthCancelUrl,
  siteAuthRequest,
  type SiteAuthSearch,
} from "@/lib/site-auth";

/* ----------------------------------------------------------------------------
   /site-auth/authorize: a published Site asks the signed-in person to open
   it as themselves. The page shows which Site and which account, with one
   action. Continue hands the Site's gateway a one-time code bound to its
   host and PKCE challenge; the gateway redeems it server-to-server for a
   session that works only on that Site. No credential reaches the Site.
   -------------------------------------------------------------------------- */

/** A minted code lives 60 seconds; mint a fresh one when it is older than this. */
const CODE_FRESH_MS = 40_000;

type SiteAuthClient = Pick<OpenGeniBrowserClient, "authorizeSiteViewer">;

type Phase =
  | { kind: "checking" }
  | { kind: "ready"; response: SiteAuthAuthorizeResponse; at: number }
  | { kind: "denied" }
  | { kind: "failed"; message: string };

export function SiteAuthorizeRoute({ search }: { search: SiteAuthSearch }) {
  const signedIn = useNativeSignInContext();
  if (signedIn)
    return (
      <SiteAuthorizePage
        client={signedIn.client}
        email={signedIn.email}
        search={search}
        onUseAnotherAccount={() => {
          // Sign-out returns home; come back here to sign in as someone else.
          const request = window.location.href;
          void signedIn.handleManagedSignOut().then(() => window.location.replace(request));
        }}
      />
    );
  return <SiteAuthorizeWithAppContext search={search} />;
}

/** Deployments without managed sign-in reach this page through the ordinary app. */
function SiteAuthorizeWithAppContext({ search }: { search: SiteAuthSearch }) {
  const { client, authSession } = useAppContext();
  return (
    <SiteAuthorizePage
      client={client}
      email={authSession?.user?.email ?? "your account"}
      search={search}
    />
  );
}

function assignLocation(url: string) {
  window.location.assign(url);
}

export function SiteAuthorizePage({
  client,
  email,
  search,
  onUseAnotherAccount,
  navigate = assignLocation,
}: {
  client: SiteAuthClient;
  email: string;
  search: SiteAuthSearch;
  onUseAnotherAccount?: (() => void) | undefined;
  navigate?: (url: string) => void;
}) {
  const request = useMemo(() => siteAuthRequest(search), [search]);
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  const [leaving, setLeaving] = useState(false);
  const clientRef = useRef(client);
  clientRef.current = client;

  // Ask first, so the page names the Site and says at once when this account
  // can't open it. The code goes nowhere until Continue.
  useEffect(() => {
    if (!request) return;
    let current = true;
    setPhase({ kind: "checking" });
    void authorize(clientRef.current, request).then((next) => {
      if (current) setPhase(next);
    });
    return () => {
      current = false;
    };
  }, [request]);

  if (!request)
    return (
      <ConsentFrame>
        <EmptyState
          variant="page"
          icon={<GlobeIcon />}
          title="Nothing to sign in to here"
          description="Open this page from Sign in on a published Site."
        />
      </ConsentFrame>
    );

  const anotherAccount = onUseAnotherAccount ? (
    <Button type="button" variant="ghost" onClick={onUseAnotherAccount}>
      Use another account
    </Button>
  ) : null;

  if (phase.kind === "denied")
    return (
      <ConsentFrame>
        <FormPage
          leading={<LogoTile icon={<LockKeyholeIcon />} />}
          title="You can't open this Site"
          description={`${email} doesn't have access to ${request.host}. Ask the Site's owner to invite this email, or use another account.`}
          submitLabel="Back to the Site"
          cancelLabel={null}
          footerStart={anotherAccount}
          onSubmit={() => {
            navigate(siteAuthCancelUrl(request));
            return false;
          }}
        />
      </ConsentFrame>
    );

  const title = phase.kind === "ready" ? phase.response.site.title : request.host;
  return (
    <ConsentFrame>
      <FormPage
        leading={<LogoTile icon={<GlobeIcon />} />}
        title={`Continue to ${title}`}
        description="The Site sees your name and email. It can't use your account anywhere else."
        submitLabel="Continue"
        pendingLabel="Continuing…"
        pending={leaving}
        submitDisabled={phase.kind === "checking"}
        onCancel={() => {
          setLeaving(true);
          navigate(siteAuthCancelUrl(request));
        }}
        footerStart={anotherAccount}
        onSubmit={async () => {
          // A code older than its lifetime would fail at the gateway, and a
          // failed check is retried: either way, mint another.
          const fresh =
            phase.kind === "ready" && Date.now() - phase.at < CODE_FRESH_MS
              ? phase
              : await authorize(client, request);
          if (fresh.kind !== "ready") {
            setPhase(fresh);
            return false;
          }
          const target = safeSiteRedirect(fresh.response.redirectTo, request);
          if (!target) throw new Error("The Site's sign-in link isn't valid. Open the Site again.");
          setLeaving(true);
          navigate(target);
          return false;
        }}
      >
        {phase.kind === "failed" ? (
          <Notice tone="failed">{phase.message}</Notice>
        ) : (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-3 text-sm">
            <dt className="text-fg-muted">Site</dt>
            <dd className="truncate text-fg">{request.host}</dd>
            <dt className="text-fg-muted">Account</dt>
            <dd className="truncate text-fg">{email}</dd>
          </dl>
        )}
      </FormPage>
    </ConsentFrame>
  );
}

async function authorize(
  client: SiteAuthClient,
  request: SiteAuthAuthorizeRequest,
): Promise<Phase> {
  try {
    const response = await client.authorizeSiteViewer(request);
    return { kind: "ready", response, at: Date.now() };
  } catch (error) {
    const { status, code } = apiErrorFacts(error);
    if (code === "site_access_denied" || status === 403) return { kind: "denied" };
    return { kind: "failed", message: userErrorText(error, "Couldn't reach the Site. Try again.") };
  }
}
