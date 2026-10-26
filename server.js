require("dotenv").config();

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const express = require("express");

const app = express();
const port = Number(process.env.PORT) || 3000;
const sessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000;
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const PRIORITIES = ["High", "Medium", "Low"];
const TIME_ESTIMATES = ["15 min", "30 min", "1 hour", "2 hours", "Half day"];
const CATEGORIES = ["Outreach/quota", "Coursework", "Personal"];
const PLANNING_CONTEXT_PATH = path.join(__dirname, "planning-context.md");
const MAX_PLANNING_CONTEXT_BYTES = 12 * 1024;

app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

const sessionCleanup = setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of sessions) {
    if (now - session.lastSeenAt >= SESSION_TTL_MS) {
      sessions.delete(sessionId);
    } else if (session.calendar?.expiresAt <= now) {
      delete session.calendar;
    }
  }
}, 5 * 60 * 1000);
sessionCleanup.unref();

function getSession(req, res) {
  const cookies = Object.fromEntries(
    (req.headers.cookie || "")
      .split(";")
      .map((cookie) => cookie.trim().split("="))
      .filter(([name, value]) => name && value)
      .map(([name, ...value]) => [name, decodeURIComponent(value.join("="))]),
  );
  let sessionId = cookies.outreach_session;
  let session = sessionId && sessions.get(sessionId);

  if (!session || Date.now() - session.lastSeenAt >= SESSION_TTL_MS) {
    if (sessionId) sessions.delete(sessionId);
    sessionId = crypto.randomBytes(32).toString("hex");
    session = { lastSeenAt: Date.now() };
    sessions.set(sessionId, session);
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    res.append(
      "Set-Cookie",
      `outreach_session=${sessionId}; Path=/; HttpOnly; SameSite=Lax${secure}`,
    );
  }

  session.lastSeenAt = Date.now();
  return session;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidDate(date) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

function validateTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > 100) {
    return "Add between 1 and 100 tasks before generating a plan.";
  }

  for (const [index, task] of tasks.entries()) {
    if (
      !isObject(task) ||
      typeof task.name !== "string" ||
      task.name.trim().length < 1 ||
      task.name.length > 160 ||
      !isValidDate(task.dueDate) ||
      !TIME_ESTIMATES.includes(task.timeEstimate) ||
      !CATEGORIES.includes(task.category) ||
      !["High", "Medium", "Low", "Let AI decide"].includes(task.priority)
    ) {
      return `Task ${index + 1} is invalid. Check its name, due date, estimate, category, and priority.`;
    }
  }

  return null;
}

function validatePlan(value) {
  if (
    !isObject(value) ||
    typeof value.summary !== "string" ||
    !value.summary.trim() ||
    !Array.isArray(value.plan) ||
    value.plan.length < 1 ||
    value.plan.length > 300
  ) {
    throw new Error("The AI returned a response in an unexpected format. Please try again.");
  }

  const plan = value.plan.map((item) => {
    if (
      !isObject(item) ||
      !DAYS.includes(item.day) ||
      typeof item.task !== "string" ||
      !item.task.trim() ||
      !PRIORITIES.includes(item.priority) ||
      !TIME_ESTIMATES.includes(item.time_estimate)
    ) {
      throw new Error("The AI returned a plan with invalid task details. Please try again.");
    }

    return {
      day: item.day,
      task: item.task.trim(),
      priority: item.priority,
      time_estimate: item.time_estimate,
      status: "pending",
    };
  });

  return { summary: value.summary.trim(), plan };
}

/**
 * Convert a TIME_ESTIMATES string to minutes.
 * @param {string} estimate
 * @returns {number}
 */
function estimateDurationMinutes(estimate) {
  const map = {
    "15 min": 15,
    "30 min": 30,
    "1 hour": 60,
    "2 hours": 120,
    "Half day": 240,
  };
  return map[estimate] ?? 60;
}

/**
 * Given a weekday name and a reference Date, return the ISO date string (YYYY-MM-DD)
 * for the matching day in the next 7 calendar days starting from the reference date (inclusive).
 * @param {string} dayName - e.g. "Monday"
 * @param {Date} referenceDate
 * @returns {string|null}
 */
function resolveWeekDate(dayName, referenceDate) {
  const dayIndex = DAYS.indexOf(dayName); // 0=Mon, 6=Sun
  for (let i = 0; i < 7; i++) {
    const d = new Date(referenceDate);
    d.setUTCDate(d.getUTCDate() + i);
    const jsDay = d.getUTCDay(); // 0=Sun,1=Mon,...6=Sat
    const ourIndex = (jsDay + 6) % 7; // 0=Mon,6=Sun
    if (ourIndex === dayIndex) return d.toISOString().slice(0, 10);
  }
  return null;
}

/**
 * Detect scheduling conflicts between existing calendar events and proposed tasks,
 * and among proposed tasks themselves.
 * @param {Array<{id:string,title:string,start:string,end:string,all_day:boolean}>} events
 * @param {Array<{date:string,startTime:string,durationMinutes:number}>} tasks
 * @param {string} timeZone - IANA timezone string (informational; dates already parsed as local ISO)
 * @returns {string[]} array of human-readable conflict descriptions
 */
function detectConflicts(events, tasks, timeZone) {
  const conflicts = [];

  // Build intervals for proposed tasks
  const taskIntervals = tasks.map((task) => {
    const startISO = `${task.date}T${task.startTime}:00`;
    const start = new Date(startISO);
    const end = new Date(start.getTime() + task.durationMinutes * 60 * 1000);
    return { start, end, label: task.task || `task at ${task.startTime} on ${task.date}` };
  });

  // Build intervals for existing timed events (skip all-day)
  const eventIntervals = events
    .filter((ev) => !ev.all_day && ev.start && ev.end)
    .map((ev) => ({
      start: new Date(ev.start),
      end: new Date(ev.end),
      label: ev.title || "Existing event",
    }));

  function overlaps(a, b) {
    return a.start < b.end && b.start < a.end;
  }

  // Each proposed task vs each existing event
  for (const task of taskIntervals) {
    for (const ev of eventIntervals) {
      if (overlaps(task, ev)) {
        conflicts.push(
          `"${task.label}" conflicts with existing event "${ev.label}" (${ev.start.toISOString()} – ${ev.end.toISOString()})`,
        );
      }
    }
  }

  // Each pair of proposed tasks among themselves
  for (let i = 0; i < taskIntervals.length; i++) {
    for (let j = i + 1; j < taskIntervals.length; j++) {
      if (overlaps(taskIntervals[i], taskIntervals[j])) {
        conflicts.push(
          `"${taskIntervals[i].label}" conflicts with "${taskIntervals[j].label}"`,
        );
      }
    }
  }

  return conflicts;
}

/**
 * Validate the incoming body for POST /api/calendar/publish.
 * @param {object} body
 * @param {string} today - YYYY-MM-DD
 * @returns {string|null} null on success, error string on failure
 */
function validatePublishPayload(body, today) {
  if (!isValidDate(today)) return "Invalid today date.";

  if (!isObject(body)) return "Request body must be a JSON object.";

  const { tasks, timeZone } = body;

  if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > 50) {
    return "tasks must be an array of 1–50 items.";
  }

  for (const [i, task] of tasks.entries()) {
    const idx = i + 1;
    if (!isObject(task)) return `Task ${idx}: must be an object.`;
    if (!Number.isInteger(task.planIndex) || task.planIndex < 0)
      return `Task ${idx}: planIndex must be a non-negative integer.`;
    if (typeof task.task !== "string" || task.task.length < 1 || task.task.length > 160)
      return `Task ${idx}: task must be a string of 1–160 characters.`;
    if (!DAYS.includes(task.day))
      return `Task ${idx}: day must be one of ${DAYS.join(", ")}.`;
    if (!TIME_ESTIMATES.includes(task.time_estimate))
      return `Task ${idx}: time_estimate must be one of ${TIME_ESTIMATES.join(", ")}.`;
    if (!isValidDate(task.date))
      return `Task ${idx}: date must be a valid ISO date (YYYY-MM-DD).`;
    if (typeof task.startTime !== "string" || !/^\d{2}:\d{2}$/.test(task.startTime)) {
      return `Task ${idx}: startTime must match HH:MM.`;
    }
    const [hh, mm] = task.startTime.split(":").map(Number);
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59)
      return `Task ${idx}: startTime is not a valid time.`;
    if (!Number.isInteger(task.durationMinutes) || task.durationMinutes < 1 || task.durationMinutes > 1440)
      return `Task ${idx}: durationMinutes must be an integer between 1 and 1440.`;
    if (
      typeof task.clientEventId !== "string" ||
      task.clientEventId.length < 1 ||
      task.clientEventId.length > 128 ||
      !/^[a-zA-Z0-9_-]+$/.test(task.clientEventId)
    ) {
      return `Task ${idx}: clientEventId must be 1–128 alphanumeric/dash/underscore characters.`;
    }
  }

  if (typeof timeZone !== "string") return "timeZone must be a string.";
  try {
    Intl.DateTimeFormat(undefined, { timeZone }).resolvedOptions();
  } catch {
    return `timeZone "${timeZone}" is not a valid IANA timezone.`;
  }

  return null;
}

function getCalendarEvents(session) {
  if (!session.calendar?.accessToken) return Promise.resolve([]);
  if (session.calendar.expiresAt <= Date.now()) {
    delete session.calendar;
    throw new Error("Your Google Calendar connection has expired. Please reconnect it.");
  }

  const timeMin = new Date();
  const timeMax = new Date(timeMin.getTime() + 7 * 24 * 60 * 60 * 1000);
  const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  url.searchParams.set("timeMin", timeMin.toISOString());
  url.searchParams.set("timeMax", timeMax.toISOString());
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", "2500");

  return fetch(url, {
    headers: { Authorization: `Bearer ${session.calendar.accessToken}` },
  }).then(async (response) => {
    if (!response.ok) {
      let detail = "";
      try {
        const errorBody = await response.json();
        detail = errorBody?.error?.message || JSON.stringify(errorBody);
        console.error("Google Calendar API error:", response.status, detail);
      } catch {
        console.error("Google Calendar API error:", response.status, "(could not parse response body)");
      }
      if (response.status === 401) {
        delete session.calendar;
        throw new Error(
          "Your Google Calendar access token has expired or been revoked. Please reconnect your calendar.",
        );
      }
      if (response.status === 403) {
        throw new Error(
          `Google Calendar API returned 403 Forbidden. Make sure the "Google Calendar API" is enabled in your Google Cloud Console project. Detail: ${detail}`,
        );
      }
      throw new Error(
        `Could not read Google Calendar events (HTTP ${response.status}). Detail: ${detail}`,
      );
    }

    const data = await response.json();
    return (data.items || []).map((event) => ({
      id: event.id || "",
      title: event.summary || "Untitled event",
      start: event.start?.dateTime || event.start?.date || "",
      end: event.end?.dateTime || event.end?.date || "",
      all_day: Boolean(event.start?.date && !event.start?.dateTime),
    }));
  });
}

async function readPlanningContext() {
  let context;
  try {
    context = await fs.readFile(PLANNING_CONTEXT_PATH, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw new Error(`Could not read planning-context.md: ${error.message}`);
  }

  if (Buffer.byteLength(context, "utf8") > MAX_PLANNING_CONTEXT_BYTES) {
    throw new Error("planning-context.md must be 12 KB or smaller. Shorten the file and try again.");
  }
  return context.trim();
}

function makePrompt(tasks, today, events, planningContext = "", calendarConnected = events.length > 0) {
  const sections = [
    "Create a realistic weekly plan for a student ambassador promoting an AWS Builder Center.",
    "Return ONLY valid JSON in exactly this shape: {\"summary\":\"2-3 encouraging but realistic sentences about the week ahead\",\"plan\":[{\"day\":\"Monday\",\"task\":\"short task name\",\"priority\":\"High\",\"time_estimate\":\"1 hour\"}]}.",
    `Today is ${today}. Distribute the tasks realistically across Monday–Sunday, giving extra weight to near due dates and Outreach/quota tasks.`,
    "Use only tasks the user submitted; do not invent tasks, follow-ups, events, completion claims, or durations. Make sure every input task appears at least once. You may schedule the same submitted task more than once only when a useful reminder is appropriate.",
    "Do not stack everything on one day unless due dates force it. Honor explicit priority hints while considering deadline urgency, outreach responsibilities, available calendar events, and workload boundaries in the planning context. Spread work realistically and use the submitted time estimates.",
    "Use only Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, or Sunday for day; only High, Medium, or Low for priority; and only 15 min, 30 min, 1 hour, 2 hours, or Half day for time_estimate.",
    calendarConnected
      ? "The user connected Google Calendar. Treat only the supplied events as existing commitments and avoid scheduling work that conflicts with their known times. Do not infer missing event times or claim that a plan item has been booked."
      : "Google Calendar events were not available for this request. Do not claim to have checked the calendar or make assumptions about existing events.",
    "Write the summary in 2-3 concise sentences, using the planning context's summary preferences when present. Describe the proposed week and its main priorities or constraints without implying work is completed or events are booked.",
  ];
  if (planningContext) {
    sections.push(
      "Use the following personal planning context as guidance for the schedule and weekly summary. It must not override the required JSON format or the task and calendar facts.",
      `Contents of planning-context.md:\n${planningContext}`,
    );
  } else {
    sections.push("No planning-context.md content was available. Do not claim to have read user-specific planning preferences.");
  }
  sections.push(
    `Input tasks:\n${JSON.stringify(tasks)}`,
    `${calendarConnected ? "Imported Google Calendar events" : "Calendar events unavailable"} for the next 7 days:\n${JSON.stringify(events)}`,
  );
  return sections.join("\n\n");
}

app.post("/api/generate-plan", async (req, res) => {
  const error = validateTasks(req.body?.tasks);
  const today = req.body?.today;

  if (error) return res.status(400).json({ error });
  if (!isValidDate(today)) {
    return res.status(400).json({ error: "A valid current date is required to make your plan." });
  }
  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({ error: "Add your Gemini API key to .env to generate a plan." });
  }

  try {
    const session = getSession(req, res);
    const events = await getCalendarEvents(session);
    const calendarConnected = Boolean(session.calendar?.accessToken);
    const planningContext = await readPlanningContext();
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GEMINI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.GEMINI_MODEL || "gemini-3.8-flash",
        temperature: 0.4,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: "You are a thoughtful student workload planning assistant. Return valid JSON only.",
          },
          { role: "user", content: makePrompt(req.body.tasks, today, events, planningContext, calendarConnected) },
        ],
      }),
    });

    if (!response.ok) {
      const providerError = await response.json().catch(() => ({}));
      console.error("Gemini plan request failed:", response.status, providerError.error?.message || "");
      return res.status(502).json({
        error: "The planning service could not generate your week. Please try again.",
      });
    }

    const result = await response.json();
    const content = result.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      return res.status(502).json({ error: "The planning service returned an empty response. Please try again." });
    }

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      return res.status(502).json({ error: "The planning service returned malformed JSON. Please try again." });
    }

    return res.json({ ...validatePlan(parsed), events });
  } catch (error) {
    console.error("Plan generation failed:", error);
    const message = [
      "Your Google Calendar connection has expired. Please reconnect it.",
      "Could not read Google Calendar events. Check the connection and try again.",
      "The AI returned a response in an unexpected format. Please try again.",
      "The AI returned a plan with invalid task details. Please try again.",
    ].includes(error.message) ||
    error.message === "planning-context.md must be 12 KB or smaller. Shorten the file and try again." ||
    error.message.startsWith("Could not read planning-context.md:")
      ? error.message
      : "Could not generate your plan. Check your connection and try again.";
    return res.status(502).json({ error: message });
  }
});

app.get("/api/calendar/status", (req, res) => {
  const session = getSession(req, res);
  if (session.calendar?.expiresAt <= Date.now()) delete session.calendar;
  res.json({ connected: Boolean(session.calendar?.accessToken) });
});

app.get("/auth/google", (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.redirect("/?calendar=unconfigured");
  }

  const session = getSession(req, res);
  const state = crypto.randomBytes(32).toString("hex");
  session.oauthState = { value: state, expiresAt: Date.now() + 10 * 60 * 1000 };
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI || `${req.protocol}://${req.get("host")}/auth/google/callback`;
  const authorizationUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorizationUrl.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID);
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("response_type", "code");
  // Narrowest scope that allows event creation (upgraded from calendar.readonly)
  authorizationUrl.searchParams.set("scope", "https://www.googleapis.com/auth/calendar.events");
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("access_type", "online");
  res.redirect(authorizationUrl.toString());
});

app.get("/auth/google/callback", async (req, res) => {
  const session = getSession(req, res);
  const oauthState = session.oauthState;
  delete session.oauthState;

  if (!oauthState || oauthState.expiresAt < Date.now() || req.query.state !== oauthState.value) {
    return res.redirect("/?calendar=error");
  }
  if (req.query.error || typeof req.query.code !== "string") {
    return res.redirect("/?calendar=error");
  }

  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI || `${req.protocol}://${req.get("host")}/auth/google/callback`;
  try {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: req.query.code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    const token = await response.json();
    if (!response.ok || !token.access_token) {
      console.error("Google OAuth token exchange failed:", response.status);
      return res.redirect("/?calendar=error");
    }

    session.calendar = {
      accessToken: token.access_token,
      expiresAt: Date.now() + Number(token.expires_in || 3600) * 1000,
    };
    return res.redirect("/?calendar=connected");
  } catch (error) {
    console.error("Google OAuth callback failed:", error);
    return res.redirect("/?calendar=error");
  }
});

app.post("/api/calendar/disconnect", async (req, res) => {
  const session = getSession(req, res);
  const accessToken = session.calendar?.accessToken;
  delete session.calendar;

  if (accessToken) {
    try {
      const response = await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: accessToken }),
      });
      if (!response.ok && response.status !== 400) {
        return res.status(502).json({
          error: "Calendar access was cleared from this app, but Google could not revoke the token.",
        });
      }
    } catch (error) {
      console.error("Google token revocation failed:", error);
      return res.status(502).json({
        error: "Calendar access was cleared from this app, but Google could not revoke the token.",
      });
    }
  }

  return res.json({ connected: false });
});

/**
 * POST /api/calendar/publish
 * Publish accepted plan items as Google Calendar events.
 * Requires a valid calendar session. Detects duplicates via extendedProperties.
 * Returns partial success: each result has { planIndex, googleEventId, skipped?, error? }.
 */
app.post("/api/calendar/publish", async (req, res) => {
  const session = getSession(req, res);

  // 1. Require valid calendar access token
  if (!session.calendar?.accessToken) {
    return res.status(401).json({
      error: "Google Calendar is not connected. Please connect your calendar first.",
    });
  }
  if (session.calendar.expiresAt <= Date.now()) {
    delete session.calendar;
    return res.status(401).json({
      error: "Your Google Calendar connection has expired. Please reconnect your calendar.",
    });
  }

  // 2. Validate payload
  const today = req.body?.today;
  const validationError = validatePublishPayload(req.body, today);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const { tasks, timeZone } = req.body;

  // 3. Fetch fresh calendar events for conflict re-check
  let freshEvents;
  try {
    freshEvents = await getCalendarEvents(session);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }

  // 4. Build task intervals for conflict detection
  const taskIntervals = tasks.map((task) => ({
    date: task.date,
    startTime: task.startTime,
    durationMinutes: task.durationMinutes,
    task: task.task,
  }));

  // 5. Detect conflicts
  const conflicts = detectConflicts(freshEvents, taskIntervals, timeZone);
  if (conflicts.length > 0) {
    return res.status(409).json({ error: "Conflicts detected", conflicts });
  }

  const accessToken = session.calendar.accessToken;
  const results = [];

  // 6 & 7. For each task: check for existing planner event (dedup), then create if new
  for (const task of tasks) {
    const startISO = `${task.date}T${task.startTime}:00`;
    const endDate = new Date(new Date(startISO).getTime() + task.durationMinutes * 60 * 1000);
    const endISO = endDate.toISOString().replace(".000Z", "").replace(/\.\d{3}Z$/, "");

    try {
      // Check for existing event with this plannerEventId
      const dupUrl = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
      dupUrl.searchParams.set("privateExtendedProperty", `plannerEventId=${task.clientEventId}`);
      dupUrl.searchParams.set("maxResults", "1");

      const dupResponse = await fetch(dupUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (dupResponse.ok) {
        const dupData = await dupResponse.json();
        if (Array.isArray(dupData.items) && dupData.items.length > 0) {
          results.push({
            planIndex: task.planIndex,
            googleEventId: dupData.items[0].id,
            skipped: true,
          });
          continue;
        }
      }

      // Create new event
      const createResponse = await fetch(
        "https://www.googleapis.com/calendar/v3/calendars/primary/events",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            summary: task.task,
            start: { dateTime: startISO, timeZone },
            end: { dateTime: endISO, timeZone },
            extendedProperties: {
              private: {
                plannerEventId: task.clientEventId,
                plannerSource: "outreach-week-planner",
              },
            },
          }),
        },
      );

      if (!createResponse.ok) {
        let detail = "";
        try {
          const errBody = await createResponse.json();
          detail = errBody?.error?.message || JSON.stringify(errBody);
        } catch { /* ignore */ }
        results.push({
          planIndex: task.planIndex,
          error: `Failed to create event (HTTP ${createResponse.status}): ${detail}`,
        });
        continue;
      }

      const created = await createResponse.json();
      results.push({ planIndex: task.planIndex, googleEventId: created.id });
    } catch (err) {
      results.push({ planIndex: task.planIndex, error: err.message });
    }
  }

  // 8. Return results (partial success is fine)
  return res.json({ results });
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Outreach Week Planner is running at http://localhost:${port}`);
  });
}

module.exports = {
  app,
  makePrompt,
  readPlanningContext,
  validatePlan,
  validateTasks,
  estimateDurationMinutes,
  resolveWeekDate,
  detectConflicts,
  validatePublishPayload,
};
