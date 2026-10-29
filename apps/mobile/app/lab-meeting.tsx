// Meeting lab: one meeting over the shared meetings fixture, without a server,
// for rendered review of naming speakers and remembering voices.
// Deep link: opengeni://lab-meeting?scheme=dark&voices=on&mine=forgotten
// voices: on, off, or left out for unknown; mine=forgotten starts with the
// reader's own voice not remembered.
import { useMeetingView } from "@opengeni/react-native/meetings";
import { useNativeTimelineTheme } from "@opengeni/react-native/timeline";
import { createMeetingsFixture } from "@opengeni/react/testing/meetings";
import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { AppThemeProvider } from "@/theme";

type Params = { scheme?: "light" | "dark"; voices?: "on" | "off"; mine?: "forgotten" };

export default function MeetingLab() {
  const params = useLocalSearchParams<Params>();
  return (
    <AppThemeProvider scheme={params.scheme ?? "light"}>
      {/* Each deep link is a fresh scenario, not an edit of the last one. */}
      <MeetingLabBody key={JSON.stringify(params)} params={params} />
    </AppThemeProvider>
  );
}

function MeetingLabBody({ params }: { params: Params }) {
  const [fixture] = useState(() => createMeetingsFixture());
  const [ready, setReady] = useState(params.mine !== "forgotten");
  useEffect(() => {
    if (params.mine !== "forgotten") return;
    void fixture.client
      .listRecordingPeople(fixture.workspaceId)
      .then(async (people) => {
        const mine = people.find((person) => person.memberSubjectId === fixture.viewerSubjectId);
        if (mine) await fixture.client.forgetRecordingPersonVoice(fixture.workspaceId, mine.id);
      })
      .finally(() => setReady(true));
  }, [fixture, params.mine]);
  return ready ? <MeetingLabScreen fixture={fixture} voices={params.voices} /> : <Loading />;
}

function MeetingLabScreen(props: {
  fixture: ReturnType<typeof createMeetingsFixture>;
  voices: Params["voices"];
}) {
  const { fixture } = props;
  const view = useMeetingView({
    recordings: fixture.client,
    workspaceId: fixture.workspaceId,
    recordingId: fixture.readyId,
    viewer: { subjectId: fixture.viewerSubjectId, name: "Ingrid Solberg" },
    ...(props.voices ? { voiceRecognition: props.voices === "on" } : {}),
  });
  const c = useNativeTimelineTheme().colors;
  return (
    <>
      <Stack.Screen
        options={{
          title: "",
          headerStyle: { backgroundColor: c.bg },
          headerTintColor: c.fg,
          headerShadowVisible: false,
        }}
      />
      {view.content}
    </>
  );
}

function Loading() {
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
      <ActivityIndicator />
    </View>
  );
}
