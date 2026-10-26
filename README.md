# Outreach Week Planner

A small, local-first weekly planner for student ambassadors. Task lists and plan decisions live only in the open browser page. An optional Google Calendar integration adds existing events to the plan and lets you publish accepted plan items directly to your calendar; its access token lives only in the server's memory and expires with the server process or token.

## Run locally

1. Install Node.js 18 or newer.
2. In this folder, run `npm install`.
3. Copy `.env.example` to `.env` and add your Gemini API key to `GEMINI_API_KEY`.
4. Start the app with `npm start`, then open [http://localhost:3000](http://localhost:3000).

The app uses the Gemini API's OpenAI-compatible Chat Completions endpoint with `gemini-3.8-flash` by default. Change `GEMINI_MODEL` in `.env` to select another compatible Gemini model. The API key is read only by the server and is never sent to the browser. The Gemini free tier has usage limits, and Google may use free-tier data to improve its products; avoid sending sensitive information.

## Architecture

```mermaid
flowchart LR
    User([User])
    Agent["Planner agent<br/>(browser + local server)"]
    Context[("Grounded knowledge<br/>planning-context.md")]
    Calendar["Tool<br/>Google Calendar API<br/>(read-only)"]
    Gemini["Gemini planning model"]
    Plan["Weekly plan + existing events"]

    User -->|"Tasks and today's date"| Agent
    Agent -->|"Read planning guidance"| Context
    Context -->|"Planning context"| Agent
    Agent -->|"Fetch next 7 days' events<br/>(when connected)"| Calendar
    Calendar -->|"Existing events"| Agent
    Agent -->|"Tasks + context + events"| Gemini
    Gemini -->|"Structured plan"| Agent
    Agent -->|"Display results"| Plan
    Plan --> User
```

## Personal planning context

Edit [`planning-context.md`](./planning-context.md) in this folder to give the planner background it should use each week. Add concise, lasting details under the headings, such as your responsibilities, usual availability, prioritization rules, workload boundaries, outreach or course requirements, and the tone you prefer for the weekly summary. Remove headings that do not apply.

The server reads this Markdown file whenever you build a week, so changes take effect on the next plan without a restart. Keep it at or under 12 KB. Its contents are sent to Gemini along with your tasks and any connected calendar events when generating a plan; do not include sensitive information.

## Weekly planning skill

The project includes a Copilot skill at [`.github/skills/weekly-outreach-summary-plan/SKILL.md`](./.github/skills/weekly-outreach-summary-plan/SKILL.md). Copilot can load it when asked to create a weekly outreach plan or summary using submitted tasks, this planning context, or available Google Calendar events.

The running planner uses Gemini rather than loading Copilot skill files. To keep its behavior aligned, the server includes the same task-grounding, workload, missing-information, and concise-summary guidance in the planning prompt. The app continues to return its existing short summary, structured plan, and separate calendar events.

## Optional: Google Calendar integration

1. In Google Cloud Console, enable the Google Calendar API and create an OAuth client for a web application.
2. Set the authorized redirect URI to `http://localhost:3000/auth/google/callback`.
3. Add the client ID, client secret, and redirect URI to `.env` as `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI`.
4. Restart the server and use **Connect calendar**.

The OAuth flow requests `https://www.googleapis.com/auth/calendar.events` — the narrowest scope that allows reading existing events and creating new ones. The server exchanges the authorization code and retains the access token in process memory only (no database, session persistence, or refresh token); the browser receives only a short-lived, HTTP-only session cookie. Disconnecting clears the token from memory and asks Google to revoke it. Calendar events are fetched when generating a plan and when publishing accepted items.

> **If you previously authorized with `calendar.readonly`**, click **Connect calendar → Disconnect**, then reconnect to grant the updated permission.

If Google OAuth is not configured, the planner works normally without calendar context.

### Publishing plan items to Calendar

After building your week and accepting items with the **✓ Accept** button, a **📅 Save to Calendar** button appears below the plan board.

**Review flow:**
1. Click **Save to Calendar** to open the review modal.
2. Each accepted task shows its resolved date (automatically mapped to the correct weekday in the coming week), a start time input (default 09:00), and a duration in minutes (pre-filled from the task's time estimate).
3. Adjust dates, times, and durations as needed, then click **Publish to Calendar**.

**Conflict detection:** Before creating any events, the server re-fetches your current calendar and checks whether the proposed times overlap with existing events or with each other. If conflicts are found, they are shown prominently in the modal so you can adjust times without leaving the page.

**Duplicate prevention:** Each plan item is tagged with a stable `clientEventId` generated when the plan loads. Before creating an event, the server queries Google Calendar for an existing event with that tag. If one is found, the item is returned as already saved (skipped) without creating a duplicate.

**Partial success:** If some events are created successfully and others fail, the modal shows per-item results. Successfully saved items receive a **📅 Saved to Calendar** badge on their plan card and are excluded from future publish attempts in the same session.

Access tokens are kept server-side at all times and are never sent to the browser.
