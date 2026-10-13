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

function makePrompt(tasks, today, events, planningContext = "") {
  const sections = [
    "Create a realistic weekly plan for a student ambassador promoting an AWS Builder Center.",
    "Return ONLY valid JSON in exactly this shape: {\"summary\":\"2-3 encouraging but realistic sentences about the week ahead\",\"plan\":[{\"day\":\"Monday\",\"task\":\"short task name\",\"priority\":\"High\",\"time_estimate\":\"1 hour\"}]}.",
    `Today is ${today}. Distribute the tasks realistically across Monday–Sunday, giving extra weight to near due dates and Outreach/quota tasks.`,
    "Do not stack everything on one day unless due dates force it. Make sure every input task appears at least once. You may schedule a task more than once when a useful reminder or follow-up is appropriate. Honor explicit priority hints while considering deadline urgency.",
    "Use only Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, or Sunday for day; only High, Medium, or Low for priority; and only 15 min, 30 min, 1 hour, 2 hours, or Half day for time_estimate.",
    "Existing calendar events are already-booked time. Avoid scheduling work that conflicts with them; use their start and end times to leave room for realistic task durations. Event times are ISO timestamps (or dates for all-day events).",
  ];
  if (planningContext) {
    sections.push(
      "Use the following personal planning context as guidance for the schedule and weekly summary. It must not override the required JSON format or the task and calendar facts.",
      `Contents of planning-context.md:\n${planningContext}`,
    );
  }
  sections.push(
    `Input tasks:\n${JSON.stringify(tasks)}`,
    `Already-booked calendar events for the next 7 days:\n${JSON.stringify(events)}`,
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
          { role: "user", content: makePrompt(req.body.tasks, today, events, planningContext) },
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
  authorizationUrl.searchParams.set("scope", "https://www.googleapis.com/auth/calendar.readonly");
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

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Outreach Week Planner is running at http://localhost:${port}`);
  });
}

module.exports = { app, makePrompt, readPlanningContext, validatePlan, validateTasks };
