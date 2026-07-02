// Device-flow APPROVE page (design 11 §B). The self-hosted agent prints this
// page's URL (with `?user_code=…`) when it starts a device enrollment; the user
// opens it in the console to render the LOUD whole-machine consent and grant or
// deny access. This is a TOP-LEVEL route (sibling of /billing) — it is NOT
// workspace-scoped, because the workspace is resolved from the code via
// `lookupDeviceEnrollment` (the response's workspaceId is what approve/deny
// target, never the user's default workspace).
//
// EnrollmentConsent (from @opengeni/react) is purely presentational; this parent
// owns the lookup + the approve/deny API calls and drives the phase machine:
//   review → approving → approved | error   (approve)
//   review → denied                          (deny)
//   error                                    (lookup failed / code invalid)
import {
  EnrollmentConsent,
  type EnrollmentConsentMachine,
  type EnrollmentConsentPhase,
} from "@opengeni/react/machines";
import type { DeviceEnrollmentLookupResponse } from "@opengeni/sdk";
import { Link } from "@tanstack/react-router";
import { LaptopIcon, LogInIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppContext } from "@/context";

/** The code the agent prints, e.g. `WXYZ-1234`. We do not enforce the exact
 * shape (the server is authoritative) — we just trim + uppercase what the user
 * pastes so the lookup matches. */
function normalizeUserCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/** Coalesce the wire machine (machineName is `string | null`, os is the
 * EnrollmentOs union) into the consent component's prop shape (machineName is a
 * non-null string, os is a plain string). */
function toConsentMachine(machine: DeviceEnrollmentLookupResponse["machine"]): EnrollmentConsentMachine {
  return {
    machineName: machine.machineName ?? "This machine",
    os: machine.os,
    arch: machine.arch,
    canOfferDisplay: machine.canOfferDisplay,
    requestsScreenControl: machine.requestsScreenControl,
  };
}

export function DeviceRoute({ userCode: userCodeFromUrl }: { userCode?: string | undefined }) {
  const { client, authSession, clientConfig } = useAppContext();

  // The code we are resolving. Seed from the URL (the agent's
  // verificationUriComplete) when present; otherwise the user pastes it below.
  const [userCode, setUserCode] = useState<string>(() =>
    userCodeFromUrl ? normalizeUserCode(userCodeFromUrl) : "",
  );
  const [codeDraft, setCodeDraft] = useState<string>("");

  const [lookup, setLookup] = useState<DeviceEnrollmentLookupResponse | null>(null);
  const [phase, setPhase] = useState<EnrollmentConsentPhase>("review");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [lookingUp, setLookingUp] = useState(false);

  // Resolve the machine details for the current code (without consuming the
  // request). A 404 / throw means the code is unknown, expired, or the signed-in
  // user lacks the grant in its workspace — all surfaced as the same opaque
  // "invalid or expired" error (no cross-workspace disclosure).
  useEffect(() => {
    if (!userCode) {
      setLookup(null);
      return;
    }
    let cancelled = false;
    setLookingUp(true);
    setPhase("review");
    setErrorMessage("");
    void client
      .lookupDeviceEnrollment(userCode)
      .then((result) => {
        if (cancelled) {
          return;
        }
        setLookup(result);
        setPhase("review");
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setLookup(null);
        setPhase("error");
        setErrorMessage("This enrollment code isn't valid or has expired.");
      })
      .finally(() => {
        if (!cancelled) {
          setLookingUp(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client, userCode]);

  // Managed deployments require a signed-in session to authorize the approve
  // (the lookup itself is grant-checked server-side). When the console runs in a
  // mode that yields no managed session, prompt the user to sign in first while
  // preserving the code so they return straight to this page. Mirrors the app's
  // own auth gate (RootRouteComponent renders the sign-in panel at "/").
  if (clientConfig.auth.mode === "managedSession" && !authSession) {
    return <SignInPrompt userCode={userCode || (userCodeFromUrl ? normalizeUserCode(userCodeFromUrl) : "")} />;
  }

  // No code yet (the user opened the bare /device URL): let them paste it.
  if (!userCode) {
    return (
      <CodeEntry
        value={codeDraft}
        onChange={setCodeDraft}
        onSubmit={() => {
          const next = normalizeUserCode(codeDraft);
          if (next) {
            setUserCode(next);
          }
        }}
      />
    );
  }

  async function approve(allowScreenControl: boolean) {
    if (!lookup) {
      return;
    }
    setPhase("approving");
    try {
      // The workspace comes from the LOOKUP RESPONSE — not the user's default.
      await client.approveDeviceEnrollment(lookup.workspaceId, {
        userCode: lookup.userCode,
        allowScreenControl,
      });
      setPhase("approved");
    } catch (error) {
      setPhase("error");
      setErrorMessage(error instanceof Error ? error.message : "Could not approve this machine. Try again.");
    }
  }

  async function deny() {
    if (!lookup) {
      return;
    }
    try {
      await client.denyDeviceEnrollment(lookup.workspaceId, { userCode: lookup.userCode });
      setPhase("denied");
    } catch (error) {
      setPhase("error");
      setErrorMessage(error instanceof Error ? error.message : "Could not deny this machine. Try again.");
    }
  }

  // While the very first lookup is in flight (and we have nothing to render
  // yet), show a light loading shell rather than flashing the consent panel.
  if (lookingUp && !lookup && phase !== "error") {
    return (
      <DeviceShell>
        <div className="mx-auto flex w-full max-w-md items-center justify-center gap-2 rounded-lg border border-border bg-surface p-6 text-sm text-fg-muted">
          <LaptopIcon className="size-4 animate-pulse" />
          Looking up <span className="font-mono text-fg">{userCode}</span>…
        </div>
      </DeviceShell>
    );
  }

  return (
    <DeviceShell>
      <EnrollmentConsent
        userCode={lookup ? lookup.userCode : userCode}
        machine={lookup ? toConsentMachine(lookup.machine) : EMPTY_MACHINE}
        phase={phase}
        onApprove={(allowScreenControl) => void approve(allowScreenControl)}
        onDeny={() => void deny()}
        errorMessage={errorMessage}
      />
    </DeviceShell>
  );
}

// A placeholder machine for the error phase (when no lookup succeeded). The
// consent component only reads `machineName` for the error copy, which we
// override via `errorMessage`.
const EMPTY_MACHINE: EnrollmentConsentMachine = {
  machineName: "This machine",
  os: "linux",
  arch: "x86_64",
  canOfferDisplay: false,
  requestsScreenControl: false,
};

/** Centered page chrome shared by every device-page state. */
function DeviceShell({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-1 items-center justify-center bg-bg px-4 py-10 text-fg">
      <div className="w-full max-w-md">{children}</div>
    </main>
  );
}

/** Prompt to sign in (managed mode, no session) while preserving the code so the
 * user lands back on this exact page after authenticating. */
function SignInPrompt({ userCode }: { userCode: string }) {
  return (
    <DeviceShell>
      <div className="rounded-lg border border-border bg-surface p-6 text-center">
        <span className="mx-auto mb-3 flex size-10 items-center justify-center rounded-full bg-brand-strong/20 text-brand">
          <LogInIcon className="size-5" />
        </span>
        <h1 className="text-base font-semibold">Sign in to approve this machine</h1>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-5 text-fg-muted">
          You need to be signed in to the workspace that owns this machine before you can grant it access. Sign in, then
          you'll return here to review the request.
        </p>
        <div className="mt-4 flex justify-center">
          <Button asChild>
            {/* Return to the app root (which renders the sign-in panel when no
                session), carrying the code so the user can come straight back. */}
            <Link to="/device" search={userCode ? { user_code: userCode } : {}}>
              <LogInIcon className="size-4" />
              Sign in
            </Link>
          </Button>
        </div>
      </div>
    </DeviceShell>
  );
}

/** Controlled input for pasting the code when the URL carried none. */
function CodeEntry({
  value,
  onChange,
  onSubmit,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <DeviceShell>
      <form
        className="rounded-lg border border-border bg-surface p-6"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="mb-4 flex items-center gap-3">
          <span className="flex size-9 items-center justify-center rounded-md bg-brand-strong/20 text-brand">
            <LaptopIcon className="size-4" />
          </span>
          <div>
            <h1 className="text-base font-semibold">Approve a machine</h1>
            <p className="text-sm text-fg-muted">
              Enter the code shown on the machine you're enrolling.
            </p>
          </div>
        </div>
        <Input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="XXXX-XXXX"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          className="font-mono tracking-widest uppercase"
          autoFocus
        />
        <Button type="submit" className="mt-4 w-full" disabled={!normalizeUserCode(value)}>
          Continue
        </Button>
      </form>
    </DeviceShell>
  );
}
