import { useState, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import { ClipboardCheck, Loader2, Send, Check, X, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Badge } from "../components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { toast } from "sonner";
import {
  getSites, listBacklinkOpportunities, listGuestPostProspects, getLinkReclamationReport,
  setOutreachRecipient, approveOutreach, rejectOutreach, sendOutreach,
} from "../lib/api";

// One entry per outreach collection the backend's Trust & Safety Gate
// (routers/outreach_gate.py) knows how to approve/send.
const SOURCES = [
  { collection: "backlink_outreach", field: "email_content", nameField: "prospect_domain", label: "Backlink Outreach", fetch: listBacklinkOpportunities, unwrap: (r) => r },
  { collection: "guest_posts", field: "pitch", nameField: "site_name", label: "Guest Posting", fetch: listGuestPostProspects, unwrap: (r) => r },
  { collection: "link_reclamation", field: "outreach_email", nameField: "broken_url", label: "Link Reclamation", fetch: getLinkReclamationReport, unwrap: (r) => r.links || [] },
];

const statusColors = {
  draft: "bg-muted text-muted-foreground",
  pending: "bg-yellow-500/10 text-yellow-400",
  approved: "bg-blue-500/10 text-blue-400",
  rejected: "bg-red-500/10 text-red-400",
  sent: "bg-emerald-500/10 text-emerald-400",
};

export default function OutreachApprovals() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [recipientDrafts, setRecipientDrafts] = useState({});

  useEffect(() => {
    getSites().then(r => { setSites(r.data); if (r.data.length > 0) setSelectedSite(r.data[0].id); }).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    if (!selectedSite) return;
    setLoading(true);
    try {
      const results = await Promise.all(SOURCES.map(src =>
        src.fetch(selectedSite).then(r => src.unwrap(r.data)).catch(() => [])
      ));
      const flat = [];
      results.forEach((docs, i) => {
        const src = SOURCES[i];
        (docs || []).forEach(doc => {
          const draft = doc[src.field];
          if (draft && draft.subject && draft.body) {
            flat.push({ ...doc, _collection: src.collection, _label: src.label, _draft: draft, _name: doc[src.nameField] });
          }
        });
      });
      setItems(flat);
    } finally { setLoading(false); }
  }, [selectedSite]);

  useEffect(() => { load(); }, [load]);

  const doAction = async (item, action) => {
    setBusyId(item.id);
    try {
      if (action === "recipient") {
        const email = recipientDrafts[item.id];
        if (!email) { toast.error("Enter a recipient email first"); return; }
        await setOutreachRecipient(item._collection, item.id, email);
        toast.success("Recipient saved");
      } else if (action === "approve") {
        await approveOutreach(item._collection, item.id);
        toast.success("Approved");
      } else if (action === "reject") {
        await rejectOutreach(item._collection, item.id);
        toast.success("Rejected");
      } else if (action === "send") {
        await sendOutreach(item._collection, item.id);
        toast.success(`Sent to ${item.recipient_email}`);
      }
      await load();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Action failed");
    } finally { setBusyId(""); }
  };

  return (
    <motion.div className="page-container" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title flex items-center gap-2"><ClipboardCheck size={24} />Outreach Approvals</h1>
          <p className="page-description">
            Every drafted outreach email across Backlink, Guest Post, and Link Reclamation, in one queue. Nothing
            sends without a real recipient email, an admin approval, and SMTP configured in Settings.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={selectedSite} onValueChange={setSelectedSite}>
            <SelectTrigger className="w-48"><SelectValue placeholder="Select site" /></SelectTrigger>
            <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 className="animate-spin" size={28} /></div>
      ) : items.length === 0 ? (
        <Card><CardContent className="py-10 text-center text-muted-foreground">No drafted outreach emails for this site yet.</CardContent></Card>
      ) : (
        <div className="space-y-3">
          {items.map(item => {
            const status = item.approval_status || "draft";
            const busy = busyId === item.id;
            return (
              <Card key={`${item._collection}-${item.id}`}>
                <CardContent className="pt-4 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-xs">{item._label}</Badge>
                        <Badge className={`text-xs ${statusColors[status]}`}>{status}</Badge>
                      </div>
                      <p className="text-sm font-medium truncate mt-1">{item._name || "(untitled)"}</p>
                      <p className="text-xs text-muted-foreground truncate">{item._draft.subject}</p>
                    </div>
                  </div>

                  {(status === "draft" || status === "rejected") && (
                    <div className="flex items-center gap-2">
                      <Input placeholder="recipient@example.com" className="h-8 text-xs"
                        value={recipientDrafts[item.id] ?? item.recipient_email ?? ""}
                        onChange={e => setRecipientDrafts({ ...recipientDrafts, [item.id]: e.target.value })} />
                      <Button size="sm" className="h-8 text-xs" disabled={busy} onClick={() => doAction(item, "recipient")}>Save recipient</Button>
                    </div>
                  )}
                  {status === "pending" && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">To: {item.recipient_email}</span>
                      <Button size="sm" variant="outline" className="h-8 text-xs" disabled={busy} onClick={() => doAction(item, "approve")}>
                        {busy ? <Loader2 size={12} className="mr-1 animate-spin" /> : <Check size={12} className="mr-1" />}Approve
                      </Button>
                      <Button size="sm" variant="outline" className="h-8 text-xs text-red-400" disabled={busy} onClick={() => doAction(item, "reject")}>
                        <X size={12} className="mr-1" />Reject
                      </Button>
                    </div>
                  )}
                  {status === "approved" && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">To: {item.recipient_email}</span>
                      <Button size="sm" className="h-8 text-xs" disabled={busy} onClick={() => doAction(item, "send")}>
                        {busy ? <Loader2 size={12} className="mr-1 animate-spin" /> : <Send size={12} className="mr-1" />}Send
                      </Button>
                    </div>
                  )}
                  {status === "sent" && (
                    <p className="text-xs text-muted-foreground">Sent to {item.recipient_email} at {item.sent_at ? new Date(item.sent_at).toLocaleString() : ""}</p>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </motion.div>
  );
}
