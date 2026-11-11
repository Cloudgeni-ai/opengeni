import { router, useLocalSearchParams } from "expo-router";
import { useEffect } from "react";
import { ActivityIndicator, View } from "react-native";
import { useAccount } from "@/account";
import { openLinkFromApp } from "@/app-link-registry";
import { appHandoffUrl } from "@/app-links";

/**
 * Where the web's "Open in app" lands (opengeni://open?url=…). It steps back to
 * whatever was on screen and opens the link from there, so Back returns to it.
 */
export default function OpenLinkScreen() {
  const { url } = useLocalSearchParams<{ url?: string }>();
  const { status } = useAccount();
  useEffect(() => {
    if (status === "loading") return;
    if (router.canGoBack()) router.back();
    else router.replace("/");
    if (url) openLinkFromApp(appHandoffUrl(url));
  }, [status, url]);
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
      <ActivityIndicator />
    </View>
  );
}
