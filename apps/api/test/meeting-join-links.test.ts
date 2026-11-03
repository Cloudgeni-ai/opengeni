import { describe, expect, test } from "bun:test";
import {
  firstMeetingJoinLink,
  meetingJoinLink,
  meetingJoinLinkIn,
} from "../src/meeting-join-links";

describe("meeting join links", () => {
  test("known services' https meeting links, named", () => {
    expect(meetingJoinLink("https://meet.google.com/abc-defg-hij")?.service).toBe("Google Meet");
    expect(meetingJoinLink("https://us02web.zoom.us/j/8123456789?pwd=abc")?.service).toBe("Zoom");
    expect(meetingJoinLink("https://zoom.us/my/someone")?.service).toBe("Zoom");
    expect(
      meetingJoinLink("https://teams.microsoft.com/l/meetup-join/19%3ameeting%40thread.v2/0")
        ?.service,
    ).toBe("Microsoft Teams");
    expect(meetingJoinLink("https://teams.live.com/meet/9876543210")?.service).toBe(
      "Microsoft Teams",
    );
    expect(meetingJoinLink("https://acme.webex.com/meet/someone")?.service).toBe("Webex");
    expect(meetingJoinLink("https://acme.webex.com/acme/j.php?MTID=m123")?.service).toBe("Webex");
    expect(meetingJoinLink("https://meet.google.com/lookup/abcdef")?.service).toBe("Google Meet");
  });

  test("never another scheme, a look-alike host, a landing page or credentials in the link", () => {
    for (const link of [
      "http://meet.google.com/abc-defg-hij",
      "zoommtg://zoom.us/join?confno=1",
      "https://meet.google.com/",
      "https://zoom.us/pricing",
      "https://zoom.us.evil.example/j/123",
      "https://evilzoom.us/j/123",
      "https://user:pass@meet.google.com/abc-defg-hij",
      "javascript:alert(1)",
      "https://teams.microsoft.com/",
      "https://meet.google.com/new",
      "https://meet.google.com/landing",
      "https://www.webex.com/pricing/index.html",
      "https://help.webex.com/en-us/article/123",
      "not a link",
      42,
    ]) {
      expect(meetingJoinLink(link)).toBeNull();
    }
  });

  test("found in text, without the sentence's punctuation; links before text", () => {
    expect(
      meetingJoinLinkIn("Docs at https://example.com/doc. Join: https://zoom.us/j/123456789.")?.url,
    ).toBe("https://zoom.us/j/123456789");
    expect(meetingJoinLinkIn("(https://meet.google.com/abc-defg-hij)")?.url).toBe(
      "https://meet.google.com/abc-defg-hij",
    );
    expect(meetingJoinLinkIn(undefined)).toBeNull();
    // An HTML description's &amp; is the link's &.
    expect(
      meetingJoinLinkIn('<a href="https://zoom.us/j/123?pwd=abc&amp;uname=x">Join</a>')?.url,
    ).toBe("https://zoom.us/j/123?pwd=abc&uname=x");
    expect(
      firstMeetingJoinLink(
        ["https://example.com/not-a-call", "https://meet.google.com/abc-defg-hij"],
        ["https://zoom.us/j/1"],
      )?.service,
    ).toBe("Google Meet");
    expect(firstMeetingJoinLink([null], ["Room 4, https://zoom.us/j/1"])?.service).toBe("Zoom");
  });
});
