# Plan: Write reviewed tasks to Google Calendar

## Problem and proposed approach

The planner currently reads primary-calendar events to guide weekly suggestions, but its Google OAuth grant is read-only and accepted plan cards exist only in browser memory. Extend that existing integration so a user can review accepted tasks as timed events and explicitly publish them to the connected account's primary calendar.

Keep task creation user-controlled: only items the user has accepted are eligible. Before sending, show their actual date and start/end times, allow edits, and require the user to resolve overlaps with existing events or other selected tasks. Default to 9:00 AM in the browser's local time zone; map weekdays to the matching date in the next seven days. Interpret “Half day” as four hours by default, while keeping the duration editable.

Use Google Calendar event metadata to recognize events created by this planner and avoid duplicates across retries or page refreshes. The server remains responsible for validating requests, checking the primary calendar for conflicts/duplicates, and creating events. Keep access tokens in the existing in-memory session model.

## Implementation todos

1. Extend the Google OAuth scope and add a validated server endpoint for creating primary-calendar events. Recheck conflicts and detect matching planner-created events before insertion.
2. Add a client-side review/edit/publish flow for accepted tasks, including local-date/time conversion, overlap handling, per-item results, and duplicate-safe UI state.
3. Update setup documentation for the expanded permission and the need to reconnect/re-authorize Google Calendar.
4. Add focused tests for request validation, event insertion, duplicate detection, conflicts, and error/partial-result behavior; run the existing test suite.

## Key files and boundaries

- `server.js`: OAuth scope, calendar API helpers, request validation, duplicate/conflict checks, and event creation endpoint.
- `public/app.js`, `public/index.html`, `public/styles.css`: review and edit scheduled events, display conflicts/results, and submit only confirmed items.
- `server.test.js`: exercise the server-side calendar write contract and preserve current read-only planning behavior.
- `README.md`: explain the broader Google permission and re-consent setup.

Out of scope: adding a database or task persistence, writing unaccepted/declined tasks, selecting non-primary calendars, or automatic conflict resolution. Continue using the current temporary in-memory OAuth session. Do not silently report success when Google rejects a write; show per-event outcomes if a batch partially succeeds.

## Decisions made with the user

- Write only tasks explicitly accepted/confirmed by the user.
- Default to a 9:00 AM start in local time, then let the user edit before saving.
- Resolve a weekday to its matching date in the next seven days.
- Require the user to resolve conflicts instead of silently moving or overlapping tasks.
- Create events in the connected account's primary calendar.
- Prevent duplicates across retries/refreshes for events created by this app.
- Use four hours as the editable default duration for “Half day”.

## Teaching notes: what changes and why

- The current integration is deliberately read-only: `server.js` requests `calendar.readonly`, fetches events for the next seven days, and the browser renders those events alongside generated suggestions. The plan cards already have Accept/Edit/Decline controls, so Accept is the natural explicit-consent boundary for writing.
- A task's weekday and estimate are insufficient to create a timed Google event. The review step supplies a real date and a local start time; duration determines the end time. Sending an explicit time zone avoids interpreting a local time as UTC.
- Calendar writes belong on the server because OAuth tokens are held in its HTTP-only session and must not be exposed to browser JavaScript. The server can validate input and give clear Google API errors.
- The OAuth permission must expand from read-only to event editing. This is a user-visible permission change, so documentation should state that Google may ask users to reconnect and approve the new scope.
- Private metadata on inserted events lets the server identify planner-created events for duplicate checks without introducing a database or confusing unrelated calendar events with duplicates.
- Calendar state and tasks remain temporary, consistent with the existing app; a newly generated schedule is not silently persisted or published.

## Prompt for Antigravity CLI

Implement the plan below in the existing repository, preserving its current architecture and style. Do not create a database or make unrelated changes.

The app currently generates weekly plan cards and reads events from a connected Google primary calendar. Extend it to create Google Calendar events from the reviewed plan:

1. Only tasks the user explicitly accepted/confirmed are eligible. Do not create events for pending or declined tasks.
2. Before publishing, present eligible tasks in a review/edit flow with actual calendar date, start time, and duration. Resolve each task's weekday to the matching date in the next seven days. Default start time to 9:00 AM in the browser's local time zone. Default duration from the existing estimate values (`15 min`, `30 min`, `1 hour`, `2 hours`, `Half day`), treating `Half day` as four hours. Let users edit date/time/duration before sending.
3. Detect overlaps with existing primary-calendar events and among selected tasks. Show conflicts and block publication until the user edits/resolves them; do not auto-move tasks or silently allow overlaps. Recheck on the server before writing to reduce race conditions.
4. Write to the connected account's primary calendar. Upgrade OAuth from `calendar.readonly` to the narrowest appropriate event-write scope; keep tokens server-side and in the existing in-memory session. Update README setup instructions to explain the new permission and reauthorization requirement.
5. Prevent duplicate planner-created events across retries and page refreshes using private Google Calendar event metadata and server-side checks, without treating unrelated events as duplicates. Ensure repeat submissions do not create duplicate events.
6. Validate all incoming dates, times, time zone, durations, task fields, and connection state on the server. Return clear errors and per-event outcomes for partial failure; never report an unsuccessful write as success. Keep each successful event's Google event ID so the UI can show its saved state and prevent repeat clicks.
7. Add focused `node:test` coverage for validation, OAuth/write behavior, conflict detection, duplicate detection, partial failures, and existing plan generation. Mock `fetch` rather than requiring live Google credentials. Run `npm test`.

Work primarily in `server.js`, `public/app.js`, `public/index.html`, `public/styles.css`, `server.test.js`, and `README.md`. Follow existing patterns, keep the client free of access tokens, and make the UI usable on mobile. Before finishing, summarize what changed, explain why each design choice was made, and report the tests run and their results.
