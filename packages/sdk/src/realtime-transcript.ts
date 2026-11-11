/**
 * Drop inline delivery tags such as `[calm]` or `[laughs]` from a voice
 * model's transcript: the voice performs them, nobody says them.
 */
export function withoutAudioTags(transcript: string): string {
  return transcript
    .replace(/\s*\[[^[\]\n]{1,40}\]\s*/gu, " ")
    .replace(/ {2,}/gu, " ")
    .trim();
}
