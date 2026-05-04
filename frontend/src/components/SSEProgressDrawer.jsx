import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, ChevronDown, ChevronUp, Loader2, CheckCircle2, XCircle, Zap, Wrench } from "lucide-react";
import { Button } from "./ui/button";
import { Progress } from "./ui/progress";
import { Badge } from "./ui/badge";
import { ScrollArea } from "./ui/scroll-area";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;

export function useSSETask() {
  const [tasks, setTasks] = useState([]);
  const sourceRefs = useRef({});

  const startTask = useCallback((taskId, label) => {
    const task = {
      id: taskId,
      label,
      events: [],
      status: "running",
      percent: 0,
      latestMessage: "Starting...",
    };
    setTasks((prev) => [...prev, task]);

    const source = new EventSource(`${BACKEND_URL}/api/stream/${taskId}`);
    sourceRefs.current[taskId] = source;

    source.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        setTasks((prev) =>
          prev.map((t) => {
            if (t.id !== taskId) return t;
            const newEvents = [...t.events, event];
            let status = t.status;
            let percent = t.percent;
            let latestMessage = t.latestMessage;

            if (event.type === "progress") {
              percent = event.data?.percent ?? percent;
              latestMessage = event.data?.message ?? latestMessage;
            } else if (event.type === "status" || event.type === "thinking") {
              latestMessage = event.data?.message ?? latestMessage;
            } else if (event.type === "complete" || event.type === "done") {
              status = "complete";
              percent = 100;
              latestMessage = event.data?.message ?? event.data?.content ?? "Done";
            } else if (event.type === "error") {
              status = "error";
              latestMessage = event.data?.message ?? "An error occurred";
            } else if (event.type === "assistant_message") {
              latestMessage = event.data?.content?.slice(0, 80) + "..." ?? latestMessage;
            } else if (event.type === "tool_call") {
              latestMessage = `Tool: ${event.data?.tool}`;
            }

            return { ...t, events: newEvents, status, percent, latestMessage };
          })
        );

        if (event.type === "done" || event.type === "complete" || event.type === "error" || event.type === "timeout") {
          source.close();
          delete sourceRefs.current[taskId];
        }
      } catch {
        // ignore parse errors
      }
    };

    source.onerror = () => {
      source.close();
      delete sourceRefs.current[taskId];
      // Before showing "Connection lost", check if the task actually completed
      // (long-running tasks may finish after the SSE stream times out).
      fetch(`${BACKEND_URL}/api/tasks/${taskId}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((taskStatus) => {
          setTasks((prev) =>
            prev.map((t) => {
              if (t.id !== taskId) return t;
              if (taskStatus?.status === "completed") {
                return { ...t, status: "complete", percent: 100, latestMessage: taskStatus.progress?.message ?? "Completed" };
              }
              return { ...t, status: "error", latestMessage: "Connection lost" };
            })
          );
        })
        .catch(() => {
          setTasks((prev) =>
            prev.map((t) => (t.id === taskId ? { ...t, status: "error", latestMessage: "Connection lost" } : t))
          );
        });
    };

    return source;
  }, []);

  const dismissTask = useCallback((taskId) => {
    if (sourceRefs.current[taskId]) {
      sourceRefs.current[taskId].close();
      delete sourceRefs.current[taskId];
    }
    setTasks((prev) => prev.filter((t) => t.id !== taskId));
  }, []);

  const dismissAll = useCallback(() => {
    Object.values(sourceRefs.current).forEach((s) => s.close());
    sourceRefs.current = {};
    setTasks([]);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      Object.values(sourceRefs.current).forEach((s) => s.close());
    };
  }, []);

  return { tasks, startTask, dismissTask, dismissAll };
}

function TaskCard({ task, onDismiss }) {
  const [expanded, setExpanded] = useState(true);

  const statusColor =
    task.status === "complete"
      ? "text-emerald-500"
      : task.status === "error"
      ? "text-red-500"
      : "text-primary";

  const StatusIcon =
    task.status === "complete"
      ? CheckCircle2
      : task.status === "error"
      ? XCircle
      : Loader2;

  return (
    <motion.div
      initial={{ opacity: 0, x: 50 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 50 }}
      className="bg-card border border-border/50 rounded-lg shadow-lg w-80 overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/30 bg-muted/30">
        <StatusIcon
          size={14}
          className={`${statusColor} ${task.status === "running" ? "animate-spin" : ""}`}
        />
        <span className="text-xs font-medium truncate flex-1">{task.label}</span>
        <Badge
          variant="outline"
          className={`text-xs ${
            task.status === "complete"
              ? "border-emerald-500/30 text-emerald-500"
              : task.status === "error"
              ? "border-red-500/30 text-red-500"
              : "border-primary/30 text-primary"
          }`}
        >
          {task.status}
        </Badge>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
        </Button>
        {(task.status === "complete" || task.status === "error") && (
          <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => onDismiss(task.id)}>
            <X size={12} />
          </Button>
        )}
      </div>

      {/* Progress bar */}
      {task.status === "running" && (
        <Progress value={task.percent} className="h-0.5 rounded-none" />
      )}
      {task.status === "complete" && (
        <div className="h-0.5 bg-emerald-500 rounded-none" />
      )}
      {task.status === "error" && (
        <div className="h-0.5 bg-red-500 rounded-none" />
      )}

      {/* Latest message */}
      <div className="px-3 py-1.5 text-xs text-muted-foreground truncate">{task.latestMessage}</div>

      {/* Expanded events */}
      <AnimatePresence>
        {expanded && task.events.length > 0 && (
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: "auto" }}
            exit={{ height: 0 }}
            className="overflow-hidden border-t border-border/20"
          >
            <ScrollArea className="h-36 px-3 py-2">
              <div className="space-y-1">
                {task.events.map((ev, idx) => (
                  <div key={idx} className="flex gap-1.5 items-start text-xs">
                    {ev.type === "tool_call" && <Wrench size={10} className="mt-0.5 text-yellow-500 flex-shrink-0" />}
                    {ev.type === "assistant_message" && <Zap size={10} className="mt-0.5 text-primary flex-shrink-0" />}
                    {ev.type === "error" && <XCircle size={10} className="mt-0.5 text-red-500 flex-shrink-0" />}
                    {ev.type === "complete" && <CheckCircle2 size={10} className="mt-0.5 text-emerald-500 flex-shrink-0" />}
                    {!["tool_call", "assistant_message", "error", "complete"].includes(ev.type) && (
                      <span className="w-2.5 flex-shrink-0" />
                    )}
                    <span className="text-muted-foreground leading-tight">
                      <span className="text-foreground/60 font-mono">[{ev.type}]</span>{" "}
                      {ev.data?.message || ev.data?.content?.slice(0, 80) || ev.data?.tool || ""}
                    </span>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export default function SSEProgressDrawer({ tasks, dismissTask }) {
  if (tasks.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 items-end">
      <AnimatePresence>
        {tasks.map((task) => (
          <TaskCard key={task.id} task={task} onDismiss={dismissTask} />
        ))}
      </AnimatePresence>
    </div>
  );
}
