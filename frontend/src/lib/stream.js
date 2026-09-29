/**
 * Server-sent-event helpers.
 *
 * EventSource cannot send headers, so the session JWT must never be used in a
 * stream URL (it would end up in proxy/access logs). Instead we ask the
 * control plane for a short-lived, single-purpose stream token
 * (`POST /stream-token`) and pass that as `?token=`.
 */
import { API_BASE, createStreamToken } from "./api";

/** Exposed for tests. */
export function buildStreamUrl(path, token) {
  const sep = path.includes("?") ? "&" : "?";
  return `${API_BASE}${path}${sep}token=${encodeURIComponent(token)}`;
}

/**
 * Open an EventSource for `path` (relative to /api) using a fresh stream token.
 * `scope` is sent to `/stream-token` so the backend can bind the token to one
 * stream (e.g. `{task_id}`), and is otherwise opaque here.
 *
 * Resolves to the EventSource; callers attach handlers and must close it.
 */
export async function openEventStream(path, scope = {}) {
  const { data } = await createStreamToken(scope);
  const token = data?.token;
  if (!token) throw new Error("Stream token missing from /stream-token response");
  return new EventSource(buildStreamUrl(path, token));
}

/** Convenience wrapper for `/stream/{task_id}`. */
export function openTaskStream(taskId) {
  return openEventStream(`/stream/${encodeURIComponent(taskId)}`, { task_id: taskId });
}

export const TERMINAL_EVENT_TYPES = ["done", "complete", "error", "timeout"];
