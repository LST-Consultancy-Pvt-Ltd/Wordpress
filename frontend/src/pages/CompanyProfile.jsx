import { useState, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import { Building2, Save, Loader2, ShieldCheck, ShieldAlert } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Badge } from "../components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { toast } from "sonner";
import { getSites, getCompanyProfile, updateCompanyProfile, listItems, apiErrorMessage } from "../lib/api";
import GatedButton from "../components/sa/GatedButton";

const EMPTY = { business_name: "", address: "", phone: "", website: "", description: "", verified: false };

export default function CompanyProfile() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [form, setForm] = useState(EMPTY);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getSites().then(r => {
      const list = listItems(r.data);
      setSites(list);
      if (list.length > 0) setSelectedSite(list[0].id);
    }).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    if (!selectedSite) return;
    setLoading(true);
    try {
      const r = await getCompanyProfile(selectedSite);
      setForm({
        business_name: r.data.business_name || "",
        address: r.data.address || "",
        phone: r.data.phone || "",
        website: r.data.website || "",
        description: r.data.description || "",
        verified: r.data.verified || false,
      });
    } catch { setForm(EMPTY); }
    finally { setLoading(false); }
  }, [selectedSite]);

  useEffect(() => { load(); }, [load]);

  const save = async (verify) => {
    setSaving(true);
    try {
      const payload = { business_name: form.business_name, address: form.address, phone: form.phone, website: form.website, description: form.description };
      if (verify !== undefined) payload.verified = verify;
      const r = await updateCompanyProfile(selectedSite, payload);
      setForm(prev => ({ ...prev, verified: r.data.verified }));
      toast.success(verify ? "Profile verified — Local Citations and other features will now use these facts" : "Profile saved");
    } catch (e) {
      toast.error(apiErrorMessage(e, "Failed to save"));
    } finally { setSaving(false); }
  };

  return (
    <motion.div className="page-container" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title flex items-center gap-2"><Building2 size={24} />Company Profile</h1>
          <p className="page-description">
            The verified source of truth for this business's real-world facts. Once verified, Local Citations
            and other features pull from here instead of asking you to re-type the same details every time.
          </p>
        </div>
        <Select value={selectedSite} onValueChange={setSelectedSite}>
          <SelectTrigger className="w-48" aria-label="Site"><SelectValue placeholder="Select site" /></SelectTrigger>
          <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">Business Facts</CardTitle>
            <CardDescription>Editing any field un-verifies the profile until you re-confirm it.</CardDescription>
          </div>
          {form.verified
            ? <Badge className="bg-emerald-500/10 text-emerald-400"><ShieldCheck size={12} className="mr-1" />Verified</Badge>
            : <Badge className="bg-yellow-500/10 text-yellow-400"><ShieldAlert size={12} className="mr-1" />Not verified</Badge>}
        </CardHeader>
        <CardContent className="space-y-4">
          {loading ? (
            <div className="flex justify-center py-8"><Loader2 className="animate-spin" size={22} /></div>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="cp-name">Business Name</Label>
                <Input id="cp-name" value={form.business_name} onChange={e => setForm({ ...form, business_name: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="cp-address">Address</Label>
                <Input id="cp-address" value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="cp-phone">Phone</Label>
                  <Input id="cp-phone" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="cp-website">Website</Label>
                  <Input id="cp-website" value={form.website} onChange={e => setForm({ ...form, website: e.target.value })} />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="cp-desc">Description</Label>
                <Input id="cp-desc" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
              </div>
              <div className="flex items-center gap-2 pt-2">
                <GatedButton minRole="editor" variant="outline" disabled={saving || !selectedSite} onClick={() => save(undefined)}>
                  {saving ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : <Save size={14} className="mr-1.5" />}Save Draft
                </GatedButton>
                <GatedButton minRole="editor" disabled={saving || !selectedSite || !form.business_name || !form.address || !form.phone} onClick={() => save(true)}>
                  <ShieldCheck size={14} className="mr-1.5" />Save &amp; Verify
                </GatedButton>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}
