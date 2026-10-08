import { RowButton } from "@/components/ui/page-actions";
import { Section } from "@/components/ui/section";
import { SettingRow } from "@/components/ui/setting-row";
import { analyticsPreferencesAvailable, openAnalyticsPreferences } from "@/lib/analytics-consent";
import type { ClientConfig } from "@/types";

/**
 * Privacy preferences, in Your account. It only exists on a deployment that
 * asks for analytics consent, and reopens the same consent choices the first
 * banner offered.
 */
export function PrivacyPreferencesSection({
  analytics,
}: {
  analytics: ClientConfig["analytics"] | undefined;
}) {
  if (!analyticsPreferencesAvailable(analytics)) return null;
  return (
    <div className="mt-8 min-w-0">
      <Section title="Privacy" description="Choose what Opengeni may collect about how you use it.">
        <SettingRow
          label="Analytics preferences"
          description="Review or change your analytics consent."
          control={<RowButton onClick={() => openAnalyticsPreferences()}>Manage</RowButton>}
        />
      </Section>
    </div>
  );
}
