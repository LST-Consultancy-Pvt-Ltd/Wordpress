import { act, renderHook, waitFor } from "@testing-library/react";
import { signIn } from "../test-utils";

jest.mock("../lib/api", () => {
  const actual = jest.requireActual("../lib/api");
  return {
    ...actual,
    createStreamToken: jest.fn(),
    getTask: jest.fn(),
  };
});

const api = require("../lib/api");
const { openTaskStream, openEventStream } = require("../lib/stream");
const { useSSETask } = require("../components/SSEProgressDrawer");
const { useTaskStream } = require("../hooks/useTaskStream");

beforeEach(() => {
  signIn("editor");
  api.createStreamToken.mockImplementation(() => Promise.resolve({ data: { token: "st_short_lived", expires_in: 120 } }));
  api.getTask.mockImplementation(() => Promise.resolve({ data: { status: "running" } }));
});

test("openTaskStream uses a stream token, never the session JWT", async () => {
  const es = await openTaskStream("task-42");
  expect(api.createStreamToken).toHaveBeenCalledWith({ task_id: "task-42" });
  expect(es.url).toMatch(/\/api\/stream\/task-42\?token=st_short_lived$/);
  expect(es.url).not.toContain("session-jwt-SECRET");
});

test("autopilot stream binds the token to autopilot:{site}", async () => {
  const es = await openEventStream("/autopilot/site-1/stream", { task_id: "autopilot:site-1" });
  expect(api.createStreamToken).toHaveBeenCalledWith({ task_id: "autopilot:site-1" });
  expect(es.url).toContain("/api/autopilot/site-1/stream?token=st_short_lived");
  expect(es.url).not.toContain("session-jwt-SECRET");
});

test("SSEProgressDrawer's useSSETask opens EventSource without the JWT", async () => {
  const { result } = renderHook(() => useSSETask());
  act(() => {
    result.current.startTask("t-1", "Scan");
  });
  await waitFor(() => expect(global.FakeEventSource.instances).toHaveLength(1));
  const es = global.FakeEventSource.instances[0];
  expect(es.url).not.toContain("session-jwt-SECRET");
  expect(es.url).toContain("token=st_short_lived");
  act(() => es.emit({ type: "complete", data: { message: "Done!" } }));
  expect(result.current.tasks[0].status).toBe("complete");
  expect(es.readyState).toBe(2);
});

test("useTaskStream reports completion from the stream", async () => {
  const onDone = jest.fn();
  const { result } = renderHook(() => useTaskStream("t-9", { onDone }));
  await waitFor(() => expect(global.FakeEventSource.instances).toHaveLength(1));
  const es = global.FakeEventSource.instances[0];
  expect(es.url).not.toContain("session-jwt-SECRET");
  act(() => es.emit({ type: "progress", data: { message: "step 1" } }));
  expect(result.current.message).toBe("step 1");
  act(() => es.emit({ type: "done", data: { message: "applied" } }));
  expect(result.current.status).toBe("complete");
  expect(onDone).toHaveBeenCalledWith("complete");
});

test("no JWT anywhere in source that opens an EventSource", () => {
  // Static guard: only lib/stream.js constructs EventSource objects.
  const fs = require("fs");
  const path = require("path");
  const root = path.join(__dirname, "..");
  const offenders = [];
  const walk = (dir) => {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((d) => {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (d.name !== "__tests__") walk(p);
      } else if (/\.(jsx?|tsx?)$/.test(d.name) && !/setupTests|test-utils/.test(d.name)) {
        const src = fs.readFileSync(p, "utf8");
        if (/new EventSource\(/.test(src) && !p.endsWith(path.join("lib", "stream.js"))) offenders.push(p);
      }
    });
  };
  walk(root);
  expect(offenders).toEqual([]);
});
