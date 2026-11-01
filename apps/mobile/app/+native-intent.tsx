import { sharedAudioRedirect } from "@opengeni/react-native/meetings";

/*
 * A phone call recording, voice memo or other audio file shared to the app
 * arrives as a link to the file. Open Meetings, where the recorder imports it,
 * instead of looking for a screen by that name. Every other link is routed as
 * it always was.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  return sharedAudioRedirect(path) ?? path;
}
