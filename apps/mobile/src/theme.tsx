import {
  Inter_400Regular,
  Inter_400Regular_Italic,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from "@expo-google-fonts/inter";
import {
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
} from "@expo-google-fonts/jetbrains-mono";
import {
  NativeTimelineThemeProvider,
  type NativeTimelineThemeOverrides,
} from "@opengeni/react-native/timeline";
import { useFonts } from "expo-font";
import type { ReactNode } from "react";
import { useColorScheme } from "react-native";

/** The web app's faces (Inter, JetBrains Mono) mapped to the native theme. */
const OVERRIDES: NativeTimelineThemeOverrides = {
  fonts: {
    sans: {
      "400": "Inter_400Regular",
      "500": "Inter_500Medium",
      "600": "Inter_600SemiBold",
      "700": "Inter_700Bold",
    },
    mono: { "400": "JetBrainsMono_400Regular", "500": "JetBrainsMono_500Medium" },
    sansItalic: "Inter_400Regular_Italic",
    // Static Inter sets ~1% tighter than the web's variable Inter at text sizes.
    sansTracking: 0.12,
  },
};

export function AppThemeProvider({
  scheme,
  children,
}: {
  scheme?: "light" | "dark";
  children: ReactNode;
}) {
  const system = useColorScheme();
  const [loaded] = useFonts({
    Inter_400Regular,
    Inter_400Regular_Italic,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    JetBrainsMono_400Regular,
    JetBrainsMono_500Medium,
  });
  return (
    <NativeTimelineThemeProvider
      scheme={scheme ?? (system === "dark" ? "dark" : "light")}
      overrides={loaded ? OVERRIDES : undefined}
    >
      {children}
    </NativeTimelineThemeProvider>
  );
}
