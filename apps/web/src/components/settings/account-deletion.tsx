import {
  ACCOUNT_DELETION_LAST_OWNER,
  AccountDeletionBlocker,
  type AccountDeletionPreview,
} from "@opengeni/contracts";
import { Button } from "@opengeni/react/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@opengeni/react/ui/dialog";
import { Input } from "@opengeni/react/ui/input";
import { Label } from "@opengeni/react/ui/label";
import { Notice } from "@opengeni/react/ui/notice";
import { Section } from "@opengeni/react/ui/section";
import { SettingRow } from "@opengeni/react/ui/setting-row";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ApiError } from "@/api";
import { ACCOUNT_DELETION_RECEIPT, createAccountDeletionApi } from "@/lib/account-deletion-api";

function deletionError(error: unknown, submitted: boolean) {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return submitted
        ? "We couldn’t verify the result. If your request was accepted, you’ll be signed out."
        : "Your sign-in has changed. Sign in again to review account deletion.";
    }
    if (error.details?.code === "ACCOUNT_DELETION_BUSY")
      return "Another change is in progress. Wait a moment and try again.";
    if (error.details?.code === "ACCOUNT_DELETION_UNAVAILABLE")
      return "Account deletion is temporarily unavailable. Try again later.";
  }
  return submitted
    ? "We couldn’t verify your request. Try the same request again."
    : "We couldn’t load what will be deleted. Try again.";
}

export function AccountDeletionSection({
  mode,
  emailAvailable,
}: {
  mode: "legacy" | "dual" | "broker";
  emailAvailable: boolean;
}) {
  const api = useMemo(() => createAccountDeletionApi(mode), [mode]);
  const field = useId();
  const operation = useRef<string | null>(null);
  const flight = useRef(false);
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<AccountDeletionPreview | null>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    void api.preview(abort.signal).then(
      (value) => {
        if (!abort.signal.aborted) setPreview(value);
      },
      (caught: unknown) => {
        if (abort.signal.aborted) return;
        if (caught instanceof ApiError && caught.details?.code === "ACCOUNT_DELETION_UNAVAILABLE") {
          setUnavailable(true);
        } else {
          setError(deletionError(caught, false));
        }
      },
    );
    return () => abort.abort();
  }, [api, open, reload]);

  function redirect() {
    try {
      sessionStorage.setItem(ACCOUNT_DELETION_RECEIPT, emailAvailable ? "email" : "no-email");
    } catch {
      /* Storage may be blocked. */
    }
    const ios = new URLSearchParams(window.location.search).get("client") === "ios";
    window.location.replace(`/account-deletion-requested${ios ? "?client=ios" : ""}`);
  }

  async function submit() {
    if (
      flight.current ||
      typed !== "DELETE" ||
      !preview ||
      preview.request ||
      preview.blockers.length > 0
    )
      return;
    flight.current = true;
    setSubmitting(true);
    setError(null);
    operation.current ??= crypto.randomUUID();
    try {
      await api.start(operation.current);
      redirect();
    } catch (caught) {
      if (caught instanceof ApiError && caught.details?.code === ACCOUNT_DELETION_LAST_OWNER) {
        const blockers = AccountDeletionBlocker.array().safeParse(caught.details.blockers);
        if (blockers.success && blockers.data.length > 0) {
          setPreview({ ...preview, blockers: blockers.data });
        } else {
          setError("Transfer organization ownership before deleting your account.");
        }
      } else {
        setError(deletionError(caught, true));
      }
    } finally {
      flight.current = false;
      setSubmitting(false);
    }
  }

  const canConfirm = preview && preview.blockers.length === 0 && !preview.request && !unavailable;
  return (
    <div className="mt-8 min-w-0">
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (flight.current) return;
          setOpen(value);
          setPreview(null);
          setError(null);
          setUnavailable(false);
          setTyped("");
        }}
      >
        <Section title="Delete account" description="Permanently delete your Opengeni account.">
          <SettingRow
            label="Account deletion"
            description="Review what will be deleted and what organizations may keep."
            control={
              <DialogTrigger asChild>
                <Button variant="outline" className="text-destructive pointer-coarse:h-11">
                  Review deletion
                </Button>
              </DialogTrigger>
            }
          />
        </Section>
        <DialogContent className="sm:max-w-lg" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete your Opengeni account?</DialogTitle>
            <DialogDescription>
              This is permanent. You’ll be signed out on all devices immediately.
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid min-w-0 gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {!preview && !error && !unavailable && (
              <p className="text-sm text-fg-subtle" role="status">
                Checking what will be deleted…
              </p>
            )}
            {unavailable && (
              <Notice tone="muted" title="Account deletion isn’t available yet">
                No changes were made to your account. Check back later.
              </Notice>
            )}
            {preview?.request && (
              <Notice tone="success" title="Deletion has already been requested">
                Your request is already recorded.
              </Notice>
            )}
            {preview && preview.blockers.length > 0 && (
              <Notice tone="failed" title="Transfer ownership first">
                You’re the last owner of {preview.blockers.map((org) => org.name).join(", ")}. Make
                another member an owner before deleting your account.
              </Notice>
            )}
            {canConfirm && (
              <div className="grid gap-3 text-sm text-fg-subtle">
                <p>
                  Deletion usually takes a few minutes and can take up to 30 days.
                  {emailAvailable
                    ? " We’ll email you when it’s complete."
                    : " This account has no email address, so we can’t send a confirmation."}
                </p>
                {preview.closeOrganizations.length > 0 && (
                  <div>
                    <h3 className="font-medium text-fg">Organizations that will close</h3>
                    <ul className="ml-5 list-disc break-words">
                      {preview.closeOrganizations.map((org) => (
                        <li key={org.organizationId}>
                          {org.name} — its workspaces will be deleted.
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {preview.leaveOrganizations.length > 0 && (
                  <div>
                    <h3 className="font-medium text-fg">Organizations you’ll leave</h3>
                    <ul className="ml-5 list-disc break-words">
                      {preview.leaveOrganizations.map((org) => (
                        <li key={org.organizationId}>
                          {org.name} —{" "}
                          {org.retention.mode === "retain"
                            ? "the organization can keep your personal workspace."
                            : `your personal workspace is kept for ${org.retention.days ?? 0} days under its policy.`}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <p>We keep billing records when required by law.</p>
                <div className="grid gap-1.5">
                  <Label htmlFor={field}>Type DELETE to confirm</Label>
                  <Input
                    id={field}
                    value={typed}
                    onChange={(event) => setTyped(event.target.value)}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    disabled={submitting}
                  />
                </div>
              </div>
            )}
            {error && (
              <div role="alert">
                <Notice tone="failed" title={error} />
              </div>
            )}
            <DialogFooter>
              <DialogClose asChild>
                <Button
                  type="button"
                  variant="outline"
                  className="pointer-coarse:h-11"
                  disabled={submitting}
                >
                  {canConfirm || (!preview && !unavailable) ? "Cancel" : "Close"}
                </Button>
              </DialogClose>
              {!preview && error && (
                <Button
                  type="button"
                  className="pointer-coarse:h-11"
                  onClick={() => {
                    setError(null);
                    setReload((value) => value + 1);
                  }}
                >
                  Try again
                </Button>
              )}
              {preview?.request && (
                <Button type="button" className="pointer-coarse:h-11" onClick={redirect}>
                  Continue
                </Button>
              )}
              {canConfirm && (
                <Button
                  type="submit"
                  variant="destructive"
                  className="pointer-coarse:h-11"
                  disabled={typed !== "DELETE" || submitting}
                >
                  {submitting ? "Requesting deletion…" : "Permanently delete account"}
                </Button>
              )}
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
