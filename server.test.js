const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { makePrompt, validatePlan, validateTasks } = require("./server");

test("accepts tasks with the documented input fields", () => {
  assert.equal(
    validateTasks([{
      name: "Host an outreach event",
      dueDate: "2026-10-01",
      timeEstimate: "1 hour",
      category: "Outreach/quota",
      priority: "Let AI decide",
    }]),
    null,
  );
});

test("rejects malformed task input with a useful error", () => {
  assert.match(validateTasks([]), /between 1 and 100 tasks/);
  assert.match(validateTasks([{ name: "", dueDate: "tomorrow" }]), /Task 1 is invalid/);
  assert.match(validateTasks([{
    name: "Finish assignment",
    dueDate: "2026-02-31",
    timeEstimate: "1 hour",
    category: "Coursework",
    priority: "High",
  }]), /Task 1 is invalid/);
});

test("validates the returned JSON and initializes each item as pending", () => {
  assert.deepEqual(
    validatePlan({
      summary: "A balanced week is ahead.",
      plan: [{ day: "Monday", task: "Prepare event post", priority: "High", time_estimate: "1 hour" }],
    }),
    {
      summary: "A balanced week is ahead.",
      plan: [{
        day: "Monday",
        task: "Prepare event post",
        priority: "High",
        time_estimate: "1 hour",
        status: "pending",
      }],
    },
  );
  assert.throws(() => validatePlan({ summary: "A week.", plan: [{ day: "Funday" }] }), /invalid task details/);
});

test("includes due dates, workload balancing, and existing events in the prompt", () => {
  const prompt = makePrompt(
    [{ name: "Write outreach post", dueDate: "2026-10-01", category: "Outreach/quota" }],
    "2026-09-27",
    [{ title: "Lecture", start: "2026-09-28T10:00:00-05:00", end: "2026-09-28T11:00:00-05:00", all_day: false }],
    "Keep Friday afternoons free.",
  );
  assert.match(prompt, /2026-09-27/);
  assert.match(prompt, /2026-10-01/);
  assert.match(prompt, /Do not stack everything on one day/);
  assert.match(prompt, /Lecture/);
  assert.match(prompt, /Keep Friday afternoons free/);
  assert.match(prompt, /weekly summary/);
});

test("generates a plan through the Gemini API", async () => {
  const originalApiKey = process.env.GEMINI_API_KEY;
  const originalFetch = global.fetch;
  let apiRequest;
  process.env.GEMINI_API_KEY = "test-gemini-key";
  global.fetch = async (url, options) => {
    apiRequest = { url, options, body: JSON.parse(options.body) };
    return {
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              summary: "A balanced week is ahead.",
              plan: [{ day: "Monday", task: "Prepare event post", priority: "High", time_estimate: "1 hour" }],
            }),
          },
        }],
      }),
    };
  };

  const server = require("./server").app.listen(0, "127.0.0.1");
  try {
    await new Promise((resolve) => server.once("listening", resolve));
    const response = await new Promise((resolve, reject) => {
      const request = http.request({
        hostname: "127.0.0.1",
        port: server.address().port,
        path: "/api/generate-plan",
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }, (result) => {
        let body = "";
        result.setEncoding("utf8");
        result.on("data", (chunk) => { body += chunk; });
        result.on("end", () => resolve({ status: result.statusCode, body: JSON.parse(body) }));
      });
      request.on("error", reject);
      request.end(JSON.stringify({
        today: "2026-09-28",
        tasks: [{
          name: "Prepare event post",
          dueDate: "2026-10-01",
          timeEstimate: "1 hour",
          category: "Outreach/quota",
          priority: "High",
        }],
      }));
    });

    assert.equal(apiRequest.url, "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    assert.equal(apiRequest.options.headers.Authorization, "Bearer test-gemini-key");
    assert.equal(apiRequest.body.model, "gemini-3.8-flash");
    assert.equal(apiRequest.body.response_format.type, "json_object");
    assert.match(apiRequest.body.messages[1].content, /Contents of planning-context\.md/);
    assert.equal(response.status, 200);
    assert.equal(response.body.summary, "A balanced week is ahead.");
    assert.equal(response.body.plan[0].status, "pending");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    global.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalApiKey;
  }
});
