---
name: weekly-outreach-summary-plan
description: "Use when creating a student's weekly outreach plan and summary from submitted tasks, planning-context.md, and available Google Calendar events."
---

# Weekly Outreach Summary Plan

Create a realistic weekly plan and short summary using only information available for the current planning request.

## Required inputs

- The tasks the user submitted for this planning session, including due dates, time estimates, categories, and priorities.
- The contents of `planning-context.md`, when available.
- Google Calendar events for the planning week, only if the user connected a calendar and the events were successfully provided to the planner.
- The current date used by the planner to interpret deadlines and the week.

Do not request or expose calendar credentials or access tokens. Do not assume a calendar is connected just because calendar support exists.

## Procedure

1. **Check the inputs.** Use the submitted tasks as the complete set of work to plan. Confirm that the planning date and task details are present and understandable. Do not silently fill in missing deadlines, estimates, priorities, or task descriptions.
2. **Read the planning context.** Apply relevant responsibilities, workload boundaries, prioritization guidance, and summary preferences from `planning-context.md`. Treat it as guidance, not a source of new tasks or events.
3. **Use calendar data only when available.** Treat successfully imported events as existing commitments and plan around their known dates and times. Do not alter, duplicate, or claim to create calendar events. If there is no connection or events were not provided, plan without calendar data and do not claim to have checked the calendar. If event timing details are incomplete, do not invent a time.
4. **Distribute submitted work realistically.** Give appropriate weight to deadlines, explicit priorities, outreach responsibilities, existing commitments, and stated workload boundaries. Spread work across the week rather than overloading one day. Use the provided time estimates; do not invent durations.
5. **Keep every plan item grounded.** Each planned item must correspond to a task the user submitted. You may place the same submitted task on more than one day only when that is a useful scheduling reminder; do not turn it into a new, unsubmitted follow-up or add unrelated tasks.
6. **Write the weekly summary.** In 2–3 concise sentences, describe the overall shape of the proposed week, its main submitted priorities, and relevant scheduling constraints. Follow the user's summary preferences when present. Do not imply that a task is completed or a calendar event is booked.
7. **Return the existing output shape.** Provide a `summary` and `plan` items containing only `day`, `task`, `priority`, and `time_estimate`, using the application's supported values. Return imported calendar events separately when the application provides them, preserving their supplied details. Do not add a prose event list or new output fields unless the application explicitly supports that format.

## Missing or unsupported information

- If `planning-context.md` is missing or empty, continue with submitted tasks and available calendar data. Do not pretend the context was read.
- If calendar data is unavailable, continue without it and do not claim anything about the user's existing events.
- If task information needed to plan is missing or invalid, ask the user to correct it or follow the application's validation error; do not fabricate values.
- If the available information cannot support a realistic schedule, state the limitation briefly in the summary and keep the plan grounded in the inputs.
- If the request conflicts with the application's supported output format or allowed values, preserve the supported format and explain the limitation rather than inventing fields or values.

## Example

Submitted task: “Prepare a campus announcement,” due Thursday, estimate 30 min, category Outreach/quota, priority High.  
Imported event: a lecture on Tuesday from 10:00 to 11:00.

Good plan item: Tuesday — “Prepare a campus announcement” — High — 30 min.  
Good summary: “The week centers on preparing the campus announcement ahead of its Thursday deadline. The imported Tuesday lecture is taken into account as an existing commitment.”

Do not add an unsubmitted task such as “Email the professor” or claim that the lecture was created by the planner.
