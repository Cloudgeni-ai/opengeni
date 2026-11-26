import { Loader2Icon } from "lucide-react";

import { Button } from "@opengeni/react/ui/button";
import type { ManagedSignInProvider } from "@opengeni/contracts/managed-sign-in-methods";

export type ManagedSocialProvider = ManagedSignInProvider;
export const SOCIAL_PROVIDER_LABELS: Record<ManagedSocialProvider, string> = {
  google: "Google",
  github: "GitHub",
  apple: "Apple",
};

export function ManagedSocialAuthButtons(props: {
  providers: readonly ManagedSocialProvider[];
  busyProvider?: ManagedSocialProvider | null;
  disabled?: boolean;
  onSelect: (provider: ManagedSocialProvider) => void;
}) {
  if (props.providers.length === 0) return null;
  return (
    <div className="grid gap-2">
      {props.providers.map((provider) => (
        <Button
          key={provider}
          type="button"
          variant="outline"
          className={
            provider === "apple"
              ? "h-11 w-full justify-center gap-0 border-black bg-black py-0 text-lg text-white hover:bg-black hover:text-white dark:border-white/40"
              : "min-h-11 w-full justify-center"
          }
          disabled={props.disabled || props.busyProvider != null}
          onClick={() => props.onSelect(provider)}
        >
          {props.busyProvider === provider ? (
            <Loader2Icon
              aria-hidden="true"
              className="size-4 animate-spin motion-reduce:animate-none"
            />
          ) : provider === "google" ? (
            <GoogleIcon />
          ) : provider === "github" ? (
            <GitHubIcon />
          ) : (
            <AppleIcon />
          )}
          Continue with {SOCIAL_PROVIDER_LABELS[provider]}
        </Button>
      ))}
    </div>
  );
}

function AppleIcon() {
  // Apple's left-aligned white artwork (medium), including its original padding.
  return (
    <svg viewBox="0 0 31 44" className="size-[31px] h-11" aria-hidden="true">
      <path
        fill="currentColor"
        d="M15.7099491,14.8846154 C16.5675461,14.8846154 17.642562,14.3048315 18.28274,13.5317864 C18.8625238,12.8312142 19.2852829,11.852829 19.2852829,10.8744437 C19.2852829,10.7415766 19.2732041,10.6087095 19.2490464,10.5 C18.2948188,10.5362365 17.1473299,11.140178 16.4588366,11.9494596 C15.9152893,12.56548 15.4200572,13.5317864 15.4200572,14.5222505 C15.4200572,14.6671964 15.4442149,14.8121424 15.4562937,14.8604577 C15.5166879,14.8725366 15.6133185,14.8846154 15.7099491,14.8846154 Z M12.6902416,29.5 C13.8618881,29.5 14.3812778,28.714876 15.8428163,28.714876 C17.3285124,28.714876 17.6546408,29.4758423 18.9591545,29.4758423 C20.2395105,29.4758423 21.0971074,28.292117 21.9063891,27.1325493 C22.8123013,25.8038779 23.1867451,24.4993643 23.2109027,24.4389701 C23.1263509,24.4148125 20.6743484,23.4122695 20.6743484,20.5979021 C20.6743484,18.1579784 22.6069612,17.0588048 22.7156707,16.974253 C21.4353147,15.1382708 19.490623,15.0899555 18.9591545,15.0899555 C17.5217737,15.0899555 16.3501271,15.9596313 15.6133185,15.9596313 C14.8161157,15.9596313 13.7652575,15.1382708 12.521138,15.1382708 C10.1536872,15.1382708 7.75,17.0950413 7.75,20.7911634 C7.75,23.0861411 8.64383344,25.513986 9.74300699,27.0842339 C10.6851558,28.4129053 11.5065162,29.5 12.6902416,29.5 Z"
      />
    </svg>
  );
}

export function ManagedAuthDivider() {
  return (
    <div className="my-4 flex items-center gap-3" aria-hidden="true">
      <span className="h-px flex-1 bg-border" />
      <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-fg-subtle">
        or use email
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.8 3-4.3 3-7.3Z"
      />
      <path
        fill="#34A853"
        d="M 12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1a5.8 5.8 0 0 1-5.5-4H3.2v2.6A10 10 0 0 0 12 22Z"
      />
      <path fill="#FBBC05" d="M6.5 14.1a6 6 0 0 1 0-4.2V7.3H3.2a10 10 0 0 0 0 9.4l3.3-2.6Z" />
      <path
        fill="#EA4335"
        d="M 12 5.9c1.5 0 2.9.5 4 1.5l3-3A10 10 0 0 0 3.2 7.3l3.3 2.6a5.8 5.8 0 0 1 5.5-4Z"
      />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden="true">
      <path
        fill="currentColor"
        d="M 12 .7a11.5 11.5 0 0 0-3.6 22.4c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.5-1.4-1.3-1.8-1.3-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2a11 11 0 0 1 5.8 0C17 4.8 18 5.1 18 5.1c.6 1.6.2 2.8.1 3.1.8.8 1.2 1.9 1.2 3.1 0 4.4-2.8 5.4-5.5 5.7.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A11.5 11.5 0 0 0 12 .7Z"
      />
    </svg>
  );
}
