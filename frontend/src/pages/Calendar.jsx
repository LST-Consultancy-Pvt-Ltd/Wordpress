import { useState, useEffect, useMemo, useCallback } from "react";
import { Calendar as BigCalendar, dateFnsLocalizer } from "react-big-calendar";
import { format, parse, startOfWeek, getDay } from "date-fns";
import { enUS } from "date-fns/locale";
import "react-big-calendar/lib/css/react-big-calendar.css";
import { motion } from "framer-motion";
import {
  CalendarDays, Loader2, AlertCircle, Sparkles, Plus, ExternalLink, RefreshCw,
} from "lucide-react";
import { Card, CardContent } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import { Badge } from "../components/ui/badge";
import { Switch } from "../components/ui/switch";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from "../components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "../components/ui/select";
import {
  getSites, getCalendarEvents, scheduleCalendarPost, generateBlogPost,
} from "../lib/api";
import { toast } from "sonner";

// ── date-fns localizer ──────────────────────────────────────────────────────
const locales = { "en-US": enUS };
const localizer = dateFnsLocalizer({
  format,
  parse,
  startOfWeek: (date) => startOfWeek(date, { weekStartsOn: 0 }),
  getDay,
  locales,
});

// ── status → colour mapping ─────────────────────────────────────────────────
const STATUS_COLORS = {
  scheduled: "#3b82f6",  // blue
  published: "#22c55e",  // green
  draft:     "#6b7280",  // gray
};

// ── helpers ─────────────────────────────────────────────────────────────────
function toLocalDatetimeInput(date) {
  // Returns "YYYY-MM-DDTHH:MM" suitable for <input type="datetime-local">
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── component ────────────────────────────────────────────────────────────────
export default function ContentCalendar() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [rawEvents, setRawEvents] = useState([]);
  const [loading, setLoading] = useState(false);

  // Schedule dialog
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [generateAI, setGenerateAI] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [form, setForm] = useState({
    title: "",
    content: "",
    scheduled_date: "",
    post_type: "post",
  });

  // Detail dialog
  const [detailOpen, setDetailOpen] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState(null);

  // ── data loading ──────────────────────────────────────────────────────────
  useEffect(() => {
    getSites()
      .then((r) => {
        const s = r.data || [];
        setSites(s);
        if (s.length) setSelectedSite(s[0].id);
      })
      .catch(() => {});
  }, []);

  const loadEvents = useCallback(async () => {
    if (!selectedSite) return;
    setLoading(true);
    try {
      const r = await getCalendarEvents(selectedSite);
      setRawEvents(r.data || []);
    } catch {
      toast.error("Failed to load calendar events");
    } finally {
      setLoading(false);
    }
  }, [selectedSite]);

  useEffect(() => { loadEvents(); }, [loadEvents]);

  // ── map raw events → BigCalendar format ───────────────────────────────────
  const calendarEvents = useMemo(() =>
    rawEvents.map((e) => {
      const start = new Date(e.scheduled_date);
      const end   = new Date(start.getTime() + 30 * 60 * 1000); // +30 min
      return { ...e, start, end, resource: e };
    }),
  [rawEvents]);

  // ── colour per status ─────────────────────────────────────────────────────
  const eventPropGetter = useCallback((event) => ({
    style: {
      backgroundColor: STATUS_COLORS[event.resource?.status] ?? STATUS_COLORS.draft,
      opacity: 0.92,
      border: "none",
    },
  }), []);

  // ── slot click → open Schedule dialog ────────────────────────────────────
  const handleSelectSlot = useCallback(({ start }) => {
    if (!selectedSite) return;
    setForm({
      title: "",
      content: "",
      scheduled_date: toLocalDatetimeInput(start),
      post_type: "post",
    });
    setGenerateAI(false);
    setScheduleOpen(true);
  }, [selectedSite]);

  // ── event click → show details ────────────────────────────────────────────
  const handleSelectEvent = useCallback((event) => {
    setSelectedEvent(event.resource);
    setDetailOpen(true);
  }, []);

  // ── AI content generation ─────────────────────────────────────────────────
  const handleGenerateAI = async () => {
    if (!form.title.trim()) {
      toast.warning("Enter a title/topic first");
      return;
    }
    setGenerating(true);
    try {
      const r = await generateBlogPost({
        site_id: selectedSite,
        topic: form.title,
        keywords: [],
        generate_image: false,
      });
      setForm((prev) => ({ ...prev, content: r.data?.content || "" }));
      toast.success("Content generated!");
    } catch (err) {
      toast.error(err.response?.data?.detail || "AI generation failed");
    } finally {
      setGenerating(false);
    }
  };

  // ── schedule submit ───────────────────────────────────────────────────────
  const handleScheduleSubmit = async (e) => {
    e.preventDefault();
    if (!form.title.trim() || !form.scheduled_date) {
      toast.warning("Title and date/time are required");
      return;
    }
    setSubmitting(true);
    try {
      await scheduleCalendarPost(selectedSite, {
        title: form.title,
        content: form.content,
        scheduled_date: new Date(form.scheduled_date).toISOString(),
        post_type: form.post_type,
      });
      toast.success(`"${form.title}" scheduled!`);
      setScheduleOpen(false);
      await loadEvents();
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to schedule post");
    } finally {
      setSubmitting(false);
    }
  };

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <div className="page-container" data-testid="calendar-page">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <motion.h1
            className="page-title"
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
          >
            Content Calendar
          </motion.h1>
          <motion.p
            className="page-description"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.1 }}
          >
            View and schedule your WordPress content
          </motion.p>
        </div>

        <div className="flex items-center gap-3">
          <Select value={selectedSite} onValueChange={setSelectedSite}>
            <SelectTrigger className="w-[200px]">
              <SelectValue placeholder="Select a site" />
            </SelectTrigger>
            <SelectContent>
              {sites.map((s) => (
                <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button variant="outline" size="icon" onClick={loadEvents} disabled={loading || !selectedSite}>
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </Button>

          <Button
            className="btn-primary"
            onClick={() => {
              if (!selectedSite) { toast.warning("Select a site first"); return; }
              setForm({ title: "", content: "", scheduled_date: toLocalDatetimeInput(new Date()), post_type: "post" });
              setGenerateAI(false);
              setScheduleOpen(true);
            }}
          >
            <Plus size={14} className="mr-2" />
            Schedule Post
          </Button>
        </div>
      </div>

      {/* Empty state */}
      {!selectedSite ? (
        <Card className="content-card">
          <CardContent className="flex flex-col items-center justify-center py-16">
            <AlertCircle size={48} className="text-muted-foreground/30 mb-4" />
            <p className="text-muted-foreground">Please select a site to view the calendar</p>
          </CardContent>
        </Card>
      ) : (
        <Card className="content-card">
          <CardContent className="p-6">
            {/* Legend */}
            <div className="flex flex-wrap gap-4 mb-5 text-xs">
              {Object.entries(STATUS_COLORS).map(([status, color]) => (
                <span key={status} className="flex items-center gap-1.5">
                  <span
                    className="w-3 h-3 rounded-sm inline-block"
                    style={{ backgroundColor: color }}
                  />
                  <span className="capitalize text-muted-foreground">{status}</span>
                </span>
              ))}
              {loading && (
                <span className="ml-auto flex items-center gap-1 text-muted-foreground">
                  <Loader2 size={12} className="animate-spin" /> Loading…
                </span>
              )}
            </div>

            {/* Calendar */}
            <div style={{ height: 620 }}>
              <BigCalendar
                localizer={localizer}
                events={calendarEvents}
                views={["month", "week", "agenda"]}
                defaultView="month"
                style={{ height: "100%" }}
                selectable
                onSelectSlot={handleSelectSlot}
                onSelectEvent={handleSelectEvent}
                eventPropGetter={eventPropGetter}
                popup
              />
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Schedule Post Dialog ─────────────────────────────────────────── */}
      <Dialog open={scheduleOpen} onOpenChange={setScheduleOpen}>
        <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Schedule a Post</DialogTitle>
            <DialogDescription>
              Create and schedule a WordPress post or page for a specific date.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleScheduleSubmit} className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Post Type</Label>
                <Select
                  value={form.post_type}
                  onValueChange={(v) => setForm((p) => ({ ...p, post_type: v }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="post">Post</SelectItem>
                    <SelectItem value="page">Page</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Scheduled Date &amp; Time</Label>
                <Input
                  type="datetime-local"
                  value={form.scheduled_date}
                  onChange={(e) => setForm((p) => ({ ...p, scheduled_date: e.target.value }))}
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Title</Label>
              <Input
                placeholder="Post title or AI topic"
                value={form.title}
                onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))}
                required
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Content</Label>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Generate with AI</span>
                  <Switch
                    checked={generateAI}
                    onCheckedChange={(v) => { setGenerateAI(v); }}
                  />
                </div>
              </div>

              {generateAI ? (
                <div className="space-y-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full"
                    onClick={handleGenerateAI}
                    disabled={generating}
                  >
                    {generating
                      ? <Loader2 size={14} className="mr-2 animate-spin" />
                      : <Sparkles size={14} className="mr-2" />}
                    {form.content ? "Re-generate content" : "Generate content from title"}
                  </Button>
                  {form.content && (
                    <Textarea
                      className="h-36 text-xs font-mono"
                      value={form.content}
                      onChange={(e) => setForm((p) => ({ ...p, content: e.target.value }))}
                    />
                  )}
                </div>
              ) : (
                <Textarea
                  placeholder="Post content (HTML or plain text)"
                  className="h-40"
                  value={form.content}
                  onChange={(e) => setForm((p) => ({ ...p, content: e.target.value }))}
                />
              )}
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setScheduleOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={submitting} className="btn-primary">
                {submitting
                  ? <Loader2 size={14} className="mr-2 animate-spin" />
                  : <CalendarDays size={14} className="mr-2" />}
                Schedule
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ── Event Detail Dialog ──────────────────────────────────────────── */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CalendarDays size={18} className="text-primary" />
              {selectedEvent?.title}
            </DialogTitle>
            <DialogDescription>Scheduled content details</DialogDescription>
          </DialogHeader>

          {selectedEvent && (
            <div className="space-y-3 py-2 text-sm">
              <div className="flex gap-2 items-center">
                <span className="text-muted-foreground w-28 shrink-0">Status</span>
                <Badge
                  variant="outline"
                  style={{
                    backgroundColor: (STATUS_COLORS[selectedEvent.status] ?? "#6b7280") + "22",
                    color: STATUS_COLORS[selectedEvent.status] ?? "#6b7280",
                    borderColor: (STATUS_COLORS[selectedEvent.status] ?? "#6b7280") + "55",
                  }}
                >
                  {selectedEvent.status}
                </Badge>
              </div>

              <div className="flex gap-2 items-center">
                <span className="text-muted-foreground w-28 shrink-0">Type</span>
                <span className="capitalize">{selectedEvent.type}</span>
              </div>

              <div className="flex gap-2 items-start">
                <span className="text-muted-foreground w-28 shrink-0">Scheduled</span>
                <span>{new Date(selectedEvent.scheduled_date).toLocaleString()}</span>
              </div>

              <div className="flex gap-2 items-center">
                <span className="text-muted-foreground w-28 shrink-0">Source</span>
                <span className="capitalize">{selectedEvent.source}</span>
              </div>

              {selectedEvent.link && (
                <div className="flex gap-2 items-center">
                  <span className="text-muted-foreground w-28 shrink-0">WordPress</span>
                  <a
                    href={selectedEvent.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline flex items-center gap-1 text-sm"
                  >
                    View post <ExternalLink size={12} />
                  </a>
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDetailOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
