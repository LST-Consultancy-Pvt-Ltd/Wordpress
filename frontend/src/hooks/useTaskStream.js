import { useEffect, useRef, useState } from "react";
import { openTaskStream, TERMINAL_EVENT_TYPES } from "../lib/stream";
import { getTask } from "../lib/api";

/**
 * Follow a control-plane task over SSE (stream-token authenticated).
 * Returns `{events, status, message}`; status ∈ idle|running|complete|error.
 * Calls `onDone(finalStatus)` once when the task reaches a terminal state.
 */
export function useTaskStream(taskId, { onDone } = {}) {
  const [events, setEvents] = useState([]);
  const [status, setStatus] = useState(taskId ? "running" : "idle");
  const [message, setMessage] = useState("");
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    if (!taskId) {
      setStatus("idle");
      return undefined;
    }
    let source = null;
    let closed = false;
    setEvents([]);
    setStatus("running");
    setMessage("Starting…");

    const finish = (final, msg) => {
      if (closed) return;
      closed = true;
      source?.close();
      setStatus(final);
      if (msg) setMessage(msg);
      doneRef.current?.(final);
    };

    const fallback = () =>
      getTask(taskId)
        .then(({ data }) => {
          if (data?.status === "completed") finish("complete", data.progress?.message || "Completed");
          else if (data?.status === "failed") finish("error", data.error || "Task failed");
          else finish("error", "Lost connection to the task stream");
        })
        .catch(() => finish("error", "Lost connection to the task stream"));

    openTaskStream(taskId)
      .then((es) => {
        if (closed) {
          es.close();
          return;
        }
        source = es;
        es.onmessage = (e) => {
          let ev;
          try {
            ev = JSON.parse(e.data);
          } catch {
            return;
          }
          setEvents((prev) => [...prev, ev]);
          const msg = ev?.data?.message || ev?.data?.content;
          if (msg) setMessage(String(msg));
          if (TERMINAL_EVENT_TYPES.includes(ev.type)) {
            finish(ev.type === "error" || ev.type === "timeout" ? "error" : "complete", msg);
          }
        };
        es.onerror = () => {
          es.close();
          fallback();
        };
      })
      .catch(fallback);

    return () => {
      closed = true;
      source?.close();
    };
  }, [taskId]);

  return { events, status, message };
}
