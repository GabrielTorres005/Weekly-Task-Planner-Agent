const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const ESTIMATES = ["15 min", "30 min", "1 hour", "2 hours", "Half day"];
const PRIORITIES = ["High", "Medium", "Low"];
// Map of time estimate label → duration in minutes (mirrors server-side estimateDurationMinutes)
const ESTIMATE_MINUTES = { "15 min": 15, "30 min": 30, "1 hour": 60, "2 hours": 120, "Half day": 240 };
// Tracks published items: planIndex → googleEventId
let publishedEventIds = new Map();

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
const publishRow = document.querySelector("#publish-row");
const publishButton = document.querySelector("#publish-button");
const publishModal = document.querySelector("#publish-modal");
const modalClose = document.querySelector("#modal-close");
const modalCancel = document.querySelector("#modal-cancel");
const modalPublish = document.querySelector("#modal-publish");
const modalBody = document.querySelector("#modal-body");

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

/**
 * Resolve a weekday name to the matching calendar date in the next 7 days from today (local).
 * Returns YYYY-MM-DD string.
 * @param {string} dayName - e.g. "Monday"
 * @returns {string}
 */
function resolveWeekDateClient(dayName) {
  const dayIndex = DAYS.indexOf(dayName); // 0=Mon, 6=Sun
  const today = new Date();
  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    const jsDay = d.getDay(); // 0=Sun,1=Mon,...6=Sat
    const ourIndex = (jsDay + 6) % 7; // 0=Mon,6=Sun
    if (ourIndex === dayIndex) return localDateString(d);
  }
  // Fallback: return today
  return localDateString();
}

/**
 * Generate a stable, unique client event ID for a given plan session + item index.
 * Called once when planItems are set; stored on each planItem as clientEventId.
 * @param {number} planIndex
 * @returns {string}
 */
function generateClientEventId(planIndex) {
  return `${Date.now().toString(36)}-${planIndex}`;
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
  const savedBadge = publishedEventIds.has(index)
    ? `<span class="saved-badge">📅 Saved to Calendar</span>`
    : "";
  return `<article class="plan-card" data-status="${status}" data-index="${index}">
    <div class="plan-card-title">${escapeHtml(item.task)}</div>
    <div class="plan-card-meta">
      <span class="priority-tag ${item.priority.toLowerCase()}">${escapeHtml(item.priority)}</span>
      <span class="time-tag">${escapeHtml(item.time_estimate)}</span>
    </div>
    ${savedBadge}
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
  updatePublishButton();
}

/**
 * Show or hide the "Publish to Calendar" button based on whether any items are accepted.
 * Also updates tooltip if calendar is not connected.
 */
function updatePublishButton() {
  const hasAccepted = planItems.some((item) => item.status === "accepted");
  publishRow.hidden = !hasAccepted;
  if (hasAccepted && calendarConnect.dataset.connected !== "true") {
    publishButton.title = "Connect your Google Calendar first to save events.";
  } else {
    publishButton.title = "";
  }
}

function showPlan() {
  planEmpty.hidden = true;
  loadingState.hidden = true;
  planResults.hidden = false;
  renderBoard();
}

// ─── Publish Modal ──────────────────────────────────────────────────────────

function openPublishModal() {
  const acceptedItems = planItems
    .map((item, index) => ({ ...item, index }))
    .filter((item) => item.status === "accepted");

  if (acceptedItems.length === 0) return;

  const rows = acceptedItems.map((item) => {
    const isPublished = publishedEventIds.has(item.index);
    const resolvedDate = resolveWeekDateClient(item.day);
    const defaultDuration = ESTIMATE_MINUTES[item.time_estimate] ?? 60;
    if (isPublished) {
      return `<div class="modal-task-row" data-plan-index="${item.index}">
        <div class="modal-task-name">${escapeHtml(item.task)}</div>
        <div class="already-saved-badge">✓ Already saved</div>
      </div>`;
    }
    return `<div class="modal-task-row" data-plan-index="${item.index}">
      <div class="modal-task-name">${escapeHtml(item.task)}</div>
      <label class="modal-field">
        <span>Date</span>
        <input type="date" name="date-${item.index}" value="${escapeHtml(resolvedDate)}" required>
      </label>
      <label class="modal-field">
        <span>Start time</span>
        <input type="time" name="time-${item.index}" value="09:00" required>
      </label>
      <label class="modal-field">
        <span>Duration (min)</span>
        <input type="number" name="duration-${item.index}" value="${defaultDuration}" min="1" max="1440" required>
      </label>
    </div>`;
  }).join("");

  modalBody.innerHTML = `
    <div id="modal-status" class="modal-status" hidden></div>
    <form id="publish-form">
      ${rows}
    </form>`;

  publishModal.hidden = false;
  document.body.style.overflow = "hidden";
}

function closePublishModal() {
  publishModal.hidden = true;
  document.body.style.overflow = "";
  modalBody.innerHTML = "";
}

function showModalStatus(message, isError = true) {
  const statusEl = document.querySelector("#modal-status");
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.className = isError ? "modal-status conflict-list" : "modal-status success-status";
  statusEl.hidden = false;
}

function showModalConflicts(conflicts) {
  const statusEl = document.querySelector("#modal-status");
  if (!statusEl) return;
  const list = conflicts.map((c) => `<li>${escapeHtml(c)}</li>`).join("");
  statusEl.innerHTML = `<strong>Conflicts detected. Please adjust the times below:</strong><ul>${list}</ul>`;
  statusEl.className = "modal-status conflict-list";
  statusEl.hidden = false;
}

async function handlePublish() {
  const form = document.querySelector("#publish-form");
  if (!form) return;

  // Gather tasks from the form, skipping already-published ones
  const acceptedItems = planItems
    .map((item, index) => ({ ...item, index }))
    .filter((item) => item.status === "accepted" && !publishedEventIds.has(item.index));

  if (acceptedItems.length === 0) {
    closePublishModal();
    return;
  }

  const tasksPayload = [];
  for (const item of acceptedItems) {
    const dateInput = form.querySelector(`input[name="date-${item.index}"]`);
    const timeInput = form.querySelector(`input[name="time-${item.index}"]`);
    const durationInput = form.querySelector(`input[name="duration-${item.index}"]`);
    if (!dateInput || !timeInput || !durationInput) continue;

    const dateVal = dateInput.value;
    const startTime = timeInput.value; // HH:MM
    const durationMinutes = parseInt(durationInput.value, 10);
    const clientEventId = item.clientEventId;

    tasksPayload.push({
      planIndex: item.index,
      task: item.task,
      day: item.day,
      time_estimate: item.time_estimate,
      date: dateVal,
      startTime,
      durationMinutes,
      clientEventId,
    });
  }

  if (tasksPayload.length === 0) {
    closePublishModal();
    return;
  }

  modalPublish.disabled = true;
  showModalStatus("Publishing…", false);

  try {
    const response = await fetch("/api/calendar/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tasks: tasksPayload,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        today: localDateString(),
      }),
    });

    const result = await response.json();

    if (response.status === 409 && result.conflicts) {
      // Show conflict details — keep modal open so user can edit
      showModalConflicts(result.conflicts);
      modalPublish.disabled = false;
      return;
    }

    if (!response.ok) {
      showModalStatus(result.error || "Failed to publish events. Please try again.");
      modalPublish.disabled = false;
      return;
    }

    // Handle results (partial success supported)
    const results = result.results || [];
    const errors = results.filter((r) => r.error);
    const successes = results.filter((r) => r.googleEventId && !r.error);

    // Store successful event IDs and update cards
    for (const r of successes) {
      publishedEventIds.set(r.planIndex, r.googleEventId);
    }

    // Re-render board to show saved badges
    renderBoard();

    if (errors.length > 0 && successes.length > 0) {
      // Partial success — show per-item results in modal
      const errorHtml = errors.map((r) => `<li>Item ${r.planIndex}: ${escapeHtml(r.error)}</li>`).join("");
      const successHtml = successes.map((r) => `<li>Item ${r.planIndex}: saved ✓${r.skipped ? " (already existed)" : ""}</li>`).join("");
      const statusEl = document.querySelector("#modal-status");
      if (statusEl) {
        statusEl.innerHTML = `<strong>${successes.length} saved, ${errors.length} failed:</strong><ul>${successHtml}${errorHtml}</ul>`;
        statusEl.className = "modal-status conflict-list";
        statusEl.hidden = false;
      }
      modalPublish.disabled = false;
    } else if (errors.length > 0) {
      const errorHtml = errors.map((r) => `<li>${escapeHtml(r.error)}</li>`).join("");
      const statusEl = document.querySelector("#modal-status");
      if (statusEl) {
        statusEl.innerHTML = `<strong>Some items could not be saved:</strong><ul>${errorHtml}</ul>`;
        statusEl.className = "modal-status conflict-list";
        statusEl.hidden = false;
      }
      modalPublish.disabled = false;
    } else {
      // All good
      closePublishModal();
      showNotice(
        `${successes.length} event${successes.length !== 1 ? "s" : ""} saved to Google Calendar.`,
        false,
      );
    }
  } catch (err) {
    showModalStatus(err instanceof Error ? err.message : "Could not publish events. Please try again.");
    modalPublish.disabled = false;
  }
}

// ─── Event Listeners ────────────────────────────────────────────────────────

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
  publishRow.hidden = true;
  publishedEventIds = new Map(); // Reset for new plan session

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
    // Assign stable clientEventId to each item once at plan load time
    const sessionPrefix = Date.now().toString(36);
    planItems = result.plan.map((item, index) => ({
      ...item,
      clientEventId: `${sessionPrefix}-${index}`,
    }));
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

// Publish button opens the review modal
publishButton.addEventListener("click", () => {
  if (calendarConnect.dataset.connected !== "true") {
    showNotice("Connect your Google Calendar first to save events to it.");
    return;
  }
  openPublishModal();
});

// Modal close / cancel
modalClose.addEventListener("click", closePublishModal);
modalCancel.addEventListener("click", closePublishModal);

// Close modal on backdrop click
publishModal.addEventListener("click", (event) => {
  if (event.target === publishModal) closePublishModal();
});

// Close modal on Escape
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !publishModal.hidden) closePublishModal();
});

// Publish submit
modalPublish.addEventListener("click", handlePublish);

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
