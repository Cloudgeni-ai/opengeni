// The link that joins a calendar event's call: Google Meet, Zoom, Microsoft
// Teams or Webex, from the event's own conference details or else from a link
// in its location or description. Only https links on those services count,
// so an event with some other link (a document, a map) is not a meeting to
// join.

/** A service whose meeting links the app knows, and how to tell them. */
type MeetingService = {
  name: string;
  matches: (url: URL) => boolean;
};

function hostIs(url: URL, domain: string): boolean {
  const host = url.hostname.toLowerCase();
  return host === domain || host.endsWith(`.${domain}`);
}

const SERVICES: readonly MeetingService[] = [
  {
    name: "Google Meet",
    // meet.google.com/abc-defg-hij; the landing page alone is no meeting.
    matches: (url) =>
      url.hostname.toLowerCase() === "meet.google.com" && /^\/[a-z0-9-]{3,}/iu.test(url.pathname),
  },
  {
    name: "Zoom",
    matches: (url) =>
      (hostIs(url, "zoom.us") || hostIs(url, "zoom.com") || hostIs(url, "zoomgov.com")) &&
      /^\/(j|my|w|wc\/join|s)\//iu.test(url.pathname),
  },
  {
    name: "Microsoft Teams",
    matches: (url) =>
      (hostIs(url, "teams.microsoft.com") ||
        hostIs(url, "teams.live.com") ||
        hostIs(url, "teams.cloud.microsoft")) &&
      /\/(l\/meetup-join|meet)\//iu.test(url.pathname),
  },
  {
    name: "Webex",
    matches: (url) => hostIs(url, "webex.com") && url.pathname.length > 1,
  },
];

/** A link to join a call, and the service it joins. */
export type MeetingJoinLink = { url: string; service: string };

/** `value` as a join link when it is an https link on a known meeting service. */
export function meetingJoinLink(value: unknown): MeetingJoinLink | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const service = SERVICES.find((candidate) => candidate.matches(url));
  return service ? { url: url.toString(), service: service.name } : null;
}

const LINK = /https:\/\/[^\s<>"'()[\]{}]+/giu;

/** The first join link in free text, such as an event's location or description. */
export function meetingJoinLinkIn(text: unknown): MeetingJoinLink | null {
  if (typeof text !== "string") return null;
  for (const match of text.slice(0, 20_000).matchAll(LINK)) {
    // Trailing punctuation belongs to the sentence, not the link.
    const found = meetingJoinLink(match[0].replace(/[.,;:!?]+$/u, ""));
    if (found) return found;
  }
  return null;
}

/** The first of `candidates` that is a join link, links before text. */
export function firstMeetingJoinLink(
  links: readonly unknown[],
  texts: readonly unknown[],
): MeetingJoinLink | null {
  for (const link of links) {
    const found = meetingJoinLink(link);
    if (found) return found;
  }
  for (const text of texts) {
    const found = meetingJoinLinkIn(text);
    if (found) return found;
  }
  return null;
}
