# Google Calendar

Opengeni's reviewed Google Calendar bridge calls the Calendar v3 REST API
through the native connection broker, the same way the [Gmail](gmail.md) bridge
does. The `https://calendarmcp.googleapis.com/mcp/v1` identity (the URL of
Google's hosted Calendar MCP server) selects this bridge; the hosted server is
never contacted. Connections are personal, scoped to the accepted initiating
human and the selected Google account, with live authority checks for every
physical provider request.

## Tools

| Tool | What it does | Default |
| --- | --- | --- |
| `list_calendars` | The account's calendars, its time zone, the current local time and weekday | Allow |
| `list_events` | Events between `timeMin` and `timeMax`, earliest first, as compact rows; optional `query` | Allow |
| `get_event` | One event's full details: description, guests and replies, organizer, video link, repeat rule | Allow |
| `find_free_busy` | Busy blocks for up to 20 calendars plus the free gaps when all are free | Allow |
| `create_event` | Adds a timed or all-day event | Ask first |
| `update_event` | Changes title, time, place, description or guests; omitted fields stay | Ask first |
| `delete_event` | Deletes one occurrence, or the whole series via its `seriesId` | Ask first |

Everyday questions need one or two calls. "What's on tomorrow" is one
`list_events` call with `timeMin` set to tomorrow's date; "am I free Thursday
afternoon" is one `find_free_busy` call. Moving an appointment is `list_events`
(with a `query`) followed by `update_event`.

`list_events` rows are compact: `eventId`, `title`, local `start`/`end`, `day`,
`allDay`, `location`, `status` (only when not confirmed), `seriesId` for
repeating events, a guest count, the user's own reply, the organizer when it is
someone else, the video link and `showsAs: "free"` for transparent events.
Repeating events are expanded into occurrences, and working-location entries are
left out. Pages default to 25 events (at most 100); follow `nextPageToken`.
`get_event` returns descriptions up to 8,000 characters and up to 100 guests,
marking truncation explicitly.

`find_free_busy` computes free gaps from every busy block Google returns. Each
calendar lists at most 200 busy blocks (`busyTruncated: true` when more exist)
and the free list is bounded the same way (`freeTruncated: true`). When any
requested calendar cannot be checked, for example because it is not shared with
the account, that calendar reports its error and no `free` list is returned,
since no time is known to be free for everyone.

## Time zones

Every tool accepts a date (`2026-03-14`), a local date and time
(`2026-03-14T09:30`) or an RFC 3339 time with an offset. Local values are read
in the `timeZone` argument when given (validated IANA name), otherwise in the
primary calendar's own time zone, falling back to UTC only when Google reports
none. Results are shown in that same zone, so the model never converts offsets
itself. `list_calendars` also returns the current local time and weekday, which
anchors relative dates such as "tomorrow" or "Friday".

A date alone as `timeMax` includes that whole day, and `list_events` without
`timeMax` covers the rest of `timeMin`'s day. Ranges are limited to one year.
Local times that fall in a daylight-saving gap move forward to the first valid
time; repeated times resolve to the later instant.

`create_event` with a date-only `start` creates an all-day event (end is
exclusive, defaulting to the next day); otherwise `end` defaults to one hour.
`update_event` that moves only the start keeps the event's length, including
across daylight-saving changes, and switching between all-day and timed is
supported. New times are read in the zone shown to the user, but a timed event
keeps its own stored time zone, so moving a series created in another zone
does not change how its later occurrences repeat.

## Changes, review and notifications

The three write tools ask first by default; the selected account's Allow / Ask
first / Block choice still controls each tool. The review shows the event's
current title and time read from Google for updates and deletions. Guests are
emailed only when `sendUpdates` is `all` or `externalOnly`; the default is
`none`.

`update_event` reads the event first and sends a PATCH guarded by the event's
ETag. If the event changed in the meantime, the call fails with a conflict
instead of overwriting someone else's edit. Guest changes use `addAttendees`
and `removeAttendees`, so existing guests and their replies are preserved.
Deleting an already deleted event reports `not_found`.

No write is retried automatically. A provider 5xx, transport failure, unreadable
response or 401 after submission returns an explicit "outcome is uncertain"
error so the agent checks the calendar instead of creating a duplicate. Read
requests may refresh once after a 401. The credential broker binding permits
only `https://www.googleapis.com/calendar/v3/` calendar list, events and
free/busy paths; the bridge cannot call another Google API.

## Scopes and Google verification

Setup requests exactly these scopes, and the connection is accepted only when
Google grants all of them:

- `https://www.googleapis.com/auth/calendar.calendarlist.readonly`: list calendars
  and read the primary calendar's time zone.
- `https://www.googleapis.com/auth/calendar.events`: read and change events.
- `https://www.googleapis.com/auth/calendar.freebusy`: free/busy lookups
  (`calendar.events` does not cover them).

The broad `calendar` scope (which also manages calendars, sharing and settings)
and `calendar.readonly` are not requested. The connection broker stores one
fixed scope set per connection and cannot add scopes later, so the event-write
scope is requested up front; people who only read still see edit access on the
consent screen. `include_granted_scopes` is not sent, so a Calendar token never
carries an account's Gmail or Drive scopes.

Google classifies Calendar scopes as sensitive, not restricted: production use
needs Google's sensitive-scope app verification (brand verification and a scope
justification with a demo video), but no CASA security assessment, unlike
Gmail and Drive. Until verification, users see an unverified-app warning and the
project is capped at 100 users. A project left in Testing expires refresh tokens
after seven days. Confirm each scope's classification on the consent screen's
Data Access page before submitting.

## Operator setup

1. In the Google Cloud project that holds the Gmail OAuth client, enable the
   **Google Calendar API**. The hosted Calendar MCP API is not required.
2. Add the three scopes above to the OAuth consent screen's Data Access list and,
   for production, submit the sensitive-scope verification.
3. Reuse the existing **Web application** client in
   `OPENGENI_INTEGRATIONS_OAUTH_CLIENTS_JSON` under `https://accounts.google.com`;
   the redirect URI stays `${OPENGENI_PUBLIC_BASE_URL}/v1/integrations/oauth/callback`.
4. Set `OPENGENI_GOOGLE_CALENDAR_ENABLED=true`. New setup also requires
   `OPENGENI_GOOGLE_CONNECTOR_SETUP_ENABLED` to stay enabled.
5. Run the reviewed catalog import. People then connect from **Capabilities**
   (search **Google Calendar**, **Connect only for me**) or from the connect
   card the agent shows in chat.

Setup requires a fresh refresh token, all three granted scopes and a successful
`GET https://www.googleapis.com/calendar/v3/users/me/calendarList/primary`; only
the primary calendar's email is stored as the account label.

Runtime descriptors and route handling live in
`packages/runtime/src/google-calendar-rest-mcp.ts`; the curated catalog pins the
allowed tools and approval recommendations. See Google's
[Calendar API reference](https://developers.google.com/workspace/calendar/api/v3/reference),
[Calendar scopes](https://developers.google.com/workspace/calendar/api/auth) and
[sensitive-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification).
