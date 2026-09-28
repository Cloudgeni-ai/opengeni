import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { LogoTile } from "@/components/ui/logo-tile";
import { SettingRow, SettingRowGroup } from "@/components/ui/setting-row";
import { Switch, type SwitchProps } from "@/components/ui/switch";
import linearLogo from "../../../../../../data/catalog/logos/linear-app-4b4a9f349c60.png";
import posthogLogo from "../../../../../../data/catalog/logos/posthog-com-bc08ccdbe582.jpg";
import { codexWorkspaceAccounts, connectedCapabilities, organization } from "../fixtures";
import { Alternative, Fork, KitSection, StateCell, StatesGrid, UsageNotes } from "../kit";
import { usePick } from "../picks";
import { alternativeLetter, type AlternativeId } from "./registry";

/* ----------------------------------------------------------------------------
   Versions map onto real Switch props.
   -------------------------------------------------------------------------- */

type VersionProps = Pick<SwitchProps, "variant" | "showStateText">;

const VERSION_PROPS: Record<AlternativeId, VersionProps> = {
  a: { variant: "brand" },
  b: { variant: "neutral" },
  c: { variant: "brand", showStateText: true },
};

const [primaryAccount, pausedAccount] = codexWorkspaceAccounts;

/** The same brand tiles as the Capabilities rows. */
const LOGOS: Record<string, { src: string; fit: "cover" | "contain" }> = {
  gmail: { src: "/capability-logos/gmail.ico", fit: "contain" },
  linear: { src: linearLogo, fit: "cover" },
  posthog: { src: posthogLogo, fit: "cover" },
};

const COPY = {
  useForNewWork: {
    label: "Use for new work",
    description:
      "When off, this account isn't picked for new chats, schedules or sessions pinned to it. Work already running continues.",
  },
  codexApps: {
    label: "Codex Apps",
    description: "Let agents use the ChatGPT apps connected to this account.",
  },
  managedReason: `Managed by ${organization.name}. Ask an organization admin to change it.`,
  adminReason: "Only workspace admins can change this.",
};

/* ----------------------------------------------------------------------------
   The same content for every version: two rows of the model account sheet and
   a strip of raw states.
   -------------------------------------------------------------------------- */

function AccountSettings({ version }: { version: VersionProps }) {
  const [useForNewWork, setUseForNewWork] = useState(primaryAccount?.useForNewWork ?? true);
  const [codexApps, setCodexApps] = useState(primaryAccount?.codexApps ?? false);
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium text-fg-subtle">
        {primaryAccount?.name} · {primaryAccount?.plan}
      </p>
      <SettingRowGroup className="mt-1">
        <SettingRow
          label={COPY.useForNewWork.label}
          description={COPY.useForNewWork.description}
          control={
            <Switch {...version} checked={useForNewWork} onCheckedChange={setUseForNewWork} />
          }
        />
        <SettingRow
          label={COPY.codexApps.label}
          description={COPY.codexApps.description}
          control={<Switch {...version} checked={codexApps} onCheckedChange={setCodexApps} />}
        />
      </SettingRowGroup>
      <div className="mt-4 grid grid-cols-4 gap-2 border-t border-border pt-4">
        <Specimen label="Off">
          <Switch {...version} aria-label="Off sample" />
        </Specimen>
        <Specimen label="On">
          <Switch {...version} aria-label="On sample" defaultChecked />
        </Specimen>
        <Specimen label="Saving">
          <Switch {...version} aria-label="Saving sample" checked pending />
        </Specimen>
        <Specimen label="Disabled">
          <Switch
            {...version}
            aria-label="Disabled sample"
            checked
            disabled
            disabledReason={COPY.managedReason}
          />
        </Specimen>
      </div>
    </div>
  );
}

function Specimen({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col items-center gap-2">
      <div className="flex h-5 items-center">{children}</div>
      <span className="text-2xs font-medium text-fg-subtle">{label}</span>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   States with behaviour.
   -------------------------------------------------------------------------- */

function SavingSwitch({ version, label }: { version: VersionProps; label: string }) {
  const [on, setOn] = useState(false);
  const [pending, setPending] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <Switch
      {...version}
      aria-label={label}
      checked={on}
      pending={pending}
      onCheckedChange={(next) => {
        setOn(next);
        setPending(true);
        timer.current = window.setTimeout(() => {
          setPending(false);
          toast.success(next ? `${label} is on` : `${label} is off`);
        }, 900);
      }}
    />
  );
}

/** Apps for this chat, as in the composer menu: small switches, 44px touch targets. */
function ComposerMenuSample({ version }: { version: VersionProps }) {
  const [enabled, setEnabled] = useState<Record<string, boolean>>({
    "cap-gmail": true,
    "cap-posthog": false,
  });
  return (
    <div className="w-full max-w-72 rounded-[16px] border border-border bg-surface p-2 shadow-og-md">
      <p className="px-2 pt-1 pb-2 text-xs font-medium text-fg-subtle">Apps in this chat</p>
      <ul className="flex flex-col">
        {connectedCapabilities.map((capability) => {
          const needsReconnect = capability.status === "needs_reconnect";
          return (
            <li
              key={capability.id}
              className="flex min-h-10 items-center gap-3 rounded-[10px] px-2 hover:bg-surface-2"
            >
              <LogoTile
                size="sm"
                name={capability.name}
                monogram={capability.monogram}
                src={capability.logoKey ? LOGOS[capability.logoKey]?.src : undefined}
                fit={capability.logoKey ? LOGOS[capability.logoKey]?.fit : undefined}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-fg">{capability.name}</span>
                {needsReconnect ? (
                  <span className="block truncate text-xs leading-4.5 text-status-waiting">
                    Needs reconnect
                  </span>
                ) : null}
              </span>
              <Switch
                {...version}
                showStateText={false}
                size="sm"
                aria-label={capability.name}
                checked={needsReconnect ? false : (enabled[capability.id] ?? false)}
                disabled={needsReconnect}
                disabledReason={needsReconnect ? capability.statusDetail : undefined}
                onCheckedChange={(next) =>
                  setEnabled((current) => ({ ...current, [capability.id]: next }))
                }
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Section
   -------------------------------------------------------------------------- */

export default function SwitchSection() {
  const pick = usePick("switch");
  const version = VERSION_PROPS[pick];
  return (
    <KitSection sectionKey="switch">
      <Fork>
        {(["a", "b", "c"] as const).map((id) => (
          <Alternative key={id} id={id} canvas="surface">
            <AccountSettings version={VERSION_PROPS[id]} />
          </Alternative>
        ))}
      </Fork>

      <StatesGrid
        columns={3}
        description={`Shown in version ${alternativeLetter(pick)}, your pick or the recommended one.`}
      >
        <StateCell label="Off">
          <Switch {...version} aria-label="Voice input" />
        </StateCell>
        <StateCell label="On">
          <Switch {...version} aria-label="Voice input" defaultChecked />
        </StateCell>
        <StateCell label="Saving" note="Spinner in the thumb. Keeps focus, ignores clicks.">
          <Switch {...version} aria-label="Voice input" checked pending />
        </StateCell>
        <StateCell label="Disabled, off" note={COPY.adminReason}>
          <Switch
            {...version}
            aria-label="Video generation"
            disabled
            disabledReason={COPY.adminReason}
          />
        </StateCell>
        <StateCell
          label="Disabled, on"
          note="Hover, focus or tap it: the reason shows in a tooltip."
        >
          <Switch
            {...version}
            aria-label="Use for new work"
            checked
            disabled
            disabledReason={COPY.managedReason}
          />
        </StateCell>
        <StateCell label="Focus" note="2px brand ring at 55%, 2px from the track.">
          <Switch
            {...version}
            aria-label="Use for new work"
            defaultChecked
            className="outline-2 outline-offset-2 outline-brand/55"
          />
        </StateCell>
        <StateCell label="Try it" note="Saves for a moment, then confirms with a toast.">
          <SavingSwitch version={version} label="Codex Apps" />
        </StateCell>
        <StateCell
          label="Small, in a menu"
          note="28x16 for composer menus. Every size gets a 44px touch target."
        >
          <ComposerMenuSample version={version} />
        </StateCell>
        <StateCell label="Error" align="stretch" note="The switch goes back; the row says why.">
          <SettingRow
            label="Use for new work"
            description={`${pausedAccount?.name ?? "This account"} is paused.`}
            error={`Couldn't resume ${pausedAccount?.name ?? "this account"}. Try again.`}
            control={<Switch {...version} checked={false} />}
          />
        </StateCell>
        <StateCell
          label="Long text"
          span={2}
          align="stretch"
          note="Labels wrap and never truncate. The switch stays centred on the text."
        >
          <SettingRow
            label="Let Codex chats switch to another provider when the Codex plan runs out mid-session"
            description="When on, a chat that hits its Codex usage limit continues on OpenGeni credits or AI Gateway instead of waiting for the limit to reset."
            control={<Switch {...version} />}
          />
        </StateCell>
        <StateCell
          label="Mobile 390"
          width="mobile"
          align="stretch"
          note="Stays on the right; the row text wraps."
        >
          <SettingRow
            label={COPY.useForNewWork.label}
            description={COPY.useForNewWork.description}
            control={<Switch {...version} defaultChecked />}
          />
        </StateCell>
      </StatesGrid>

      <UsageNotes
        use={[
          "One on/off setting that saves the moment it changes: Voice input, Use for new work, Only me chats",
          "Pausing and resuming one thing, like a schedule or an account",
          "Turning apps on for one chat in the composer menu (small size)",
        ]}
        avoid={[
          "Inside a form with a Save button: use a checkbox",
          "Choosing between two named options (Spread work | Primary only): use a segmented control",
          "Anything that needs a confirmation, like Delete or Revoke: use a button",
          "A disabled switch without a reason: say why and who can change it",
        ]}
      />
    </KitSection>
  );
}
