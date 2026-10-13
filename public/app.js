const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const ESTIMATES = ["15 min", "30 min", "1 hour", "2 hours", "Half day"];
const PRIORITIES = ["High", "Medium", "Low"];
const tasks = [];
let planItems = [];
let calendarEvents = [];
let isGenerating = false;
let noticeTimer;

const taskForm = document.querySelector("#task-form");
const taskName = document.querySelector("#task-name");
const taskDue = document.querySelector("#task-due");
const taskList = document.querySelector("#task-list");
const taskCount = document.querySelector("#task-count");
const listEmpty = document.querySelector("#list-empty");
const generateButton = document.querySelector("#generate-button");
const generateLabel = document.querySelector("#generate-label");
const planEmpty = document.querySelector("#plan-empty");
const loadingState = document.querySelector("#loading-state");
const planResults = document.querySelector("#plan-results");
const board = document.querySelector("#board");
const notice = document.querySelector("#notice");
const calendarConnect = document.querySelector("#calendar-connect");
const calendarLabel = document.querySelector("#calendar-label");

function localDateString(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function showNotice(message, isError = true) {
  clearTimeout(noticeTimer);
  notice.textContent = message;
  notice.hidden = false;
  notice.dataset.kind = isError ? "error" : "info";
  noticeTimer = setTimeout(() => { notice.hidden = true; }, 8000);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function formatShortDate(date) {
  const parsed = new Date(`${date}T12:00:00`);
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function renderTasks() {
  taskList.innerHTML = tasks.map((task, index) => `
    <li class="task-row">
      <div class="task-row-copy">
        <div class="task-row-name" title="${escapeHtml(task.name)}">${escapeHtml(task.name)}</div>
        <div class="task-row-meta">
          <span>Due ${formatShortDate(task.dueDate)}</span>
          <span>${escapeHtml(task.timeEstimate)}</span>
          <span>${escapeHtml(task.category)}</span>
        </div>
      </div>
      <button class="remove-task" type="button" aria-label="Remove ${escapeHtml(task.name)}" data-remove="${index}">×</button>
    </li>`).join("");
  taskCount.textContent = `${String(tasks.length).padStart(2, "0")} ${tasks.length === 1 ? "TASK" : "TASKS"}`;
  listEmpty.hidden = tasks.length > 0;
  generateButton.disabled = tasks.length === 0 || isGenerating;
}

function groupEventsByDay(events) {
  const grouped = Object.fromEntries(DAYS.map((day) => [day, []]));
  for (const event of events) {
    const date = event.start.slice(0, 10);
    const weekday = new Date(`${date}T12:00:00`).getDay();
    const day = DAYS[(weekday + 6) % 7];
    grouped[day].push(event);
  }
  return grouped;
}

function formatEventTime(event) {
  if (event.all_day) return "All day";
  if (!event.start || !event.end) return "";
  const start = new Date(event.start);
  const end = new Date(event.end);
  const options = { hour: "numeric", minute: "2-digit" };
  return `${start.toLocaleTimeString(undefined, options)}–${end.toLocaleTimeString(undefined, options)}`;
}

function renderCard(item, index) {
  const status = item.status || "pending";
  return `<article class="plan-card" data-status="${status}" data-index="${index}">
    <div class="plan-card-title">${escapeHtml(item.task)}</div>
    <div class="plan-card-meta">
      <span class="priority-tag ${item.priority.toLowerCase()}">${escapeHtml(item.priority)}</span>
      <span class="time-tag">${escapeHtml(item.time_estimate)}</span>
    </div>
    ${status !== "pending" ? `<div class="status-label">${status === "accepted" ? "✓ CONFIRMED" : "↺ DECLINED"}</div>` : ""}
    ${status === "editing" ? renderEditForm(item, index) : `<div class="card-actions">
      <button class="action-accept" type="button" data-action="accept" data-index="${index}">${status === "accepted" ? "Undo" : "✓ Accept"}</button>
      <button type="button" data-action="edit" data-index="${index}">Edit</button>
      <button class="action-decline" type="button" data-action="decline" data-index="${index}">${status === "declined" ? "Undo" : "Decline"}</button>
    </div>`}
  </article>`;
}

function renderEditForm(item, index) {
  return `<form class="edit-form" data-edit-form="${index}">
    <input name="task" type="text" maxlength="160" value="${escapeHtml(item.task)}" aria-label="Task name" required>
    <select name="day" aria-label="Day">${DAYS.map((day) => `<option${day === item.day ? " selected" : ""}>${day}</option>`).join("")}</select>
    <select name="priority" aria-label="Priority">${PRIORITIES.map((priority) => `<option${priority === item.priority ? " selected" : ""}>${priority}</option>`).join("")}</select>
    <select name="time_estimate" aria-label="Time estimate">${ESTIMATES.map((estimate) => `<option${estimate === item.time_estimate ? " selected" : ""}>${estimate}</option>`).join("")}</select>
    <div class="edit-actions"><button type="submit">Save</button><button type="button" data-action="cancel-edit" data-index="${index}">Cancel</button></div>
  </form>`;
}

function renderBoard() {
  const eventsByDay = groupEventsByDay(calendarEvents);
  board.innerHTML = DAYS.map((day) => {
    const dayItems = planItems
      .map((item, index) => ({ ...item, index }))
      .filter((item) => item.day === day);
    const eventMarkup = eventsByDay[day].map((event) => `
      <article class="event-card">
        <div class="event-title">${escapeHtml(event.title)}</div>
        <div class="event-label">◦ EXISTING EVENT · ${escapeHtml(formatEventTime(event))}</div>
      </article>`).join("");
    const planMarkup = dayItems.map((item) => renderCard(item, item.index)).join("");
    return `<section class="day-column" aria-label="${day}">
      <h3 class="day-heading">${day}</h3>
      <div class="day-cards">${eventMarkup}${planMarkup || (!eventMarkup ? '<span class="day-blank">A little breathing room</span>' : "")}</div>
    </section>`;
  }).join("");
}

function showPlan() {
  planEmpty.hidden = true;
  loadingState.hidden = true;
  planResults.hidden = false;
  renderBoard();
}

taskDue.value = localDateString();
taskDue.min = localDateString();

taskForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const formData = new FormData(taskForm);
  const name = String(formData.get("name")).trim();
  if (!name) return;

  tasks.push({
    name,
    dueDate: String(formData.get("dueDate")),
    timeEstimate: String(formData.get("timeEstimate")),
    category: String(formData.get("category")),
    priority: String(formData.get("priority")),
  });
  renderTasks();
  taskName.value = "";
  taskName.focus();
});

taskList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove]");
  if (!button) return;
  tasks.splice(Number(button.dataset.remove), 1);
  renderTasks();
});

generateButton.addEventListener("click", async () => {
  if (tasks.length === 0 || isGenerating) return;
  isGenerating = true;
  renderTasks();
  generateLabel.textContent = "Finding your rhythm…";
  notice.hidden = true;
  planEmpty.hidden = true;
  planResults.hidden = true;
  loadingState.hidden = false;

  try {
    const response = await fetch("/api/generate-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tasks, today: localDateString() }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Something went wrong while generating your plan.");
    if (!result || typeof result.summary !== "string" || !Array.isArray(result.plan) || !Array.isArray(result.events)) {
      throw new Error("The planning service returned an incomplete plan. Please try again.");
    }
    planItems = result.plan.map((item) => ({ ...item }));
    calendarEvents = result.events;
    document.querySelector("#plan-summary").textContent = result.summary;
    showPlan();
  } catch (error) {
    loadingState.hidden = true;
    planEmpty.hidden = false;
    showNotice(error instanceof Error ? error.message : "Could not generate your plan. Please try again.");
  } finally {
    isGenerating = false;
    generateLabel.textContent = "Build my week";
    renderTasks();
  }
});

board.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const index = Number(button.dataset.index);
  const item = planItems[index];
  if (!item) return;

  switch (button.dataset.action) {
    case "accept":
      item.status = item.status === "accepted" ? "pending" : "accepted";
      break;
    case "decline":
      item.status = item.status === "declined" ? "pending" : "declined";
      break;
    case "edit":
      item.statusBeforeEdit = item.status;
      item.status = "editing";
      break;
    case "cancel-edit":
      item.status = item.statusBeforeEdit || "pending";
      delete item.statusBeforeEdit;
      break;
    default:
      return;
  }
  renderBoard();
});

board.addEventListener("submit", (event) => {
  const form = event.target.closest("[data-edit-form]");
  if (!form) return;
  event.preventDefault();
  const index = Number(form.dataset.editForm);
  const item = planItems[index];
  if (!item) return;
  const data = new FormData(form);
  item.task = String(data.get("task")).trim();
  item.day = String(data.get("day"));
  item.priority = String(data.get("priority"));
  item.time_estimate = String(data.get("time_estimate"));
  item.status = item.statusBeforeEdit || "pending";
  delete item.statusBeforeEdit;
  renderBoard();
});

async function refreshCalendarStatus() {
  try {
    const response = await fetch("/api/calendar/status");
    if (!response.ok) throw new Error("Could not check calendar connection status.");
    const status = await response.json();
    const params = new URLSearchParams(window.location.search);
    if (params.has("calendar")) {
      const outcome = params.get("calendar");
      if (outcome === "connected") showNotice("Google Calendar is connected. Existing events will be shown the next time you build your week.", false);
      if (outcome === "unconfigured") showNotice("To connect Google Calendar, add your Google OAuth client ID and secret to .env first.");
      if (outcome === "error") showNotice("Google Calendar could not be connected. Please try again.");
      window.history.replaceState({}, "", window.location.pathname);
    }
    calendarLabel.textContent = status.connected ? "Calendar connected · Disconnect" : "Connect calendar";
    calendarConnect.setAttribute("aria-label", status.connected ? "Disconnect Google Calendar" : "Connect Google Calendar");
    calendarConnect.dataset.connected = String(status.connected);
  } catch (error) {
    showNotice(error instanceof Error ? error.message : "Could not check calendar connection.");
  }
}

calendarConnect.addEventListener("click", async () => {
  if (calendarConnect.dataset.connected !== "true") {
    window.location.assign("/auth/google");
    return;
  }

  calendarConnect.disabled = true;
  try {
    const response = await fetch("/api/calendar/disconnect", { method: "POST" });
    const result = await response.json();
    calendarEvents = [];
    if (!response.ok) showNotice(result.error || "Google Calendar could not be disconnected.");
    else showNotice("Google Calendar disconnected. Existing events were removed from this plan.", false);
    calendarLabel.textContent = "Connect calendar";
    calendarConnect.dataset.connected = "false";
    if (!planResults.hidden) renderBoard();
  } catch {
    calendarEvents = [];
    calendarLabel.textContent = "Connect calendar";
    calendarConnect.dataset.connected = "false";
    if (!planResults.hidden) renderBoard();
    showNotice("Google Calendar access was cleared from this app, but disconnect could not be confirmed.");
  } finally {
    calendarConnect.disabled = false;
  }
});

renderTasks();
refreshCalendarStatus();
