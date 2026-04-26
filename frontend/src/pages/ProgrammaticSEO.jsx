import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  Layers, Plus, Trash2, Globe, Loader2, RefreshCw, Upload, MapPin, Wrench, CheckCircle2, ExternalLink
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import { Badge } from "../components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Checkbox } from "../components/ui/checkbox";
import { toast } from "sonner";
import {
  getSites, generateProgrammaticPages, listProgrammaticPages,
  pushProgrammaticPages, deleteProgrammaticPage, subscribeToTask
} from "../lib/api";

const CITIES = [
  { city: "New York", state: "NY", population: 8336817 },
  { city: "Los Angeles", state: "CA", population: 3979576 },
  { city: "Chicago", state: "IL", population: 2693976 },
  { city: "Houston", state: "TX", population: 2304580 },
  { city: "Phoenix", state: "AZ", population: 1608139 },
  { city: "Philadelphia", state: "PA", population: 1603797 },
  { city: "San Antonio", state: "TX", population: 1434625 },
  { city: "San Diego", state: "CA", population: 1386932 },
  { city: "Dallas", state: "TX", population: 1304379 },
  { city: "San Jose", state: "CA", population: 1013240 },
  { city: "Austin", state: "TX", population: 978908 },
  { city: "Jacksonville", state: "FL", population: 911507 },
  { city: "Fort Worth", state: "TX", population: 895008 },
  { city: "Columbus", state: "OH", population: 898553 },
  { city: "Charlotte", state: "NC", population: 885708 },
  { city: "Indianapolis", state: "IN", population: 876384 },
  { city: "San Francisco", state: "CA", population: 881549 },
  { city: "Seattle", state: "WA", population: 753675 },
  { city: "Denver", state: "CO", population: 715522 },
  { city: "Nashville", state: "TN", population: 689447 },
  { city: "Oklahoma City", state: "OK", population: 655057 },
  { city: "El Paso", state: "TX", population: 678815 },
  { city: "Washington", state: "DC", population: 689545 },
  { city: "Las Vegas", state: "NV", population: 641903 },
  { city: "Louisville", state: "KY", population: 633045 },
  { city: "Memphis", state: "TN", population: 651073 },
  { city: "Portland", state: "OR", population: 652503 },
  { city: "Baltimore", state: "MD", population: 593490 },
  { city: "Milwaukee", state: "WI", population: 590157 },
  { city: "Albuquerque", state: "NM", population: 564559 },
  { city: "Tucson", state: "AZ", population: 542629 },
  { city: "Fresno", state: "CA", population: 531576 },
  { city: "Sacramento", state: "CA", population: 513624 },
  { city: "Mesa", state: "AZ", population: 504258 },
  { city: "Kansas City", state: "MO", population: 495327 },
  { city: "Atlanta", state: "GA", population: 498715 },
  { city: "Omaha", state: "NE", population: 486051 },
  { city: "Colorado Springs", state: "CO", population: 472688 },
  { city: "Raleigh", state: "NC", population: 467665 },
  { city: "Long Beach", state: "CA", population: 466742 },
  { city: "Virginia Beach", state: "VA", population: 459470 },
  { city: "Minneapolis", state: "MN", population: 429606 },
  { city: "Tampa", state: "FL", population: 399700 },
  { city: "New Orleans", state: "LA", population: 390144 },
  { city: "Arlington", state: "TX", population: 394266 },
  { city: "Orlando", state: "FL", population: 307573 },
  { city: "Pittsburgh", state: "PA", population: 302971 },
  { city: "St. Louis", state: "MO", population: 308174 },
  { city: "Cincinnati", state: "OH", population: 309317 },
  { city: "Reno", state: "NV", population: 255601 },
  { city: "Baton Rouge", state: "LA", population: 220236 },
  { city: "Irvine", state: "CA", population: 282572 },
  { city: "Irving", state: "TX", population: 239798 },
  { city: "Scottsdale", state: "AZ", population: 254995 },
  { city: "Fremont", state: "CA", population: 230504 },
  { city: "Gilbert", state: "AZ", population: 254114 },
  { city: "Boise", state: "ID", population: 235684 },
  { city: "Rochester", state: "NY", population: 211328 },
  { city: "Richmond", state: "VA", population: 226610 },
  { city: "Spokane", state: "WA", population: 222081 },
  { city: "Des Moines", state: "IA", population: 214237 },
  { city: "Salt Lake City", state: "UT", population: 200544 },
  { city: "Madison", state: "WI", population: 269840 },
  { city: "Durham", state: "NC", population: 278993 },
];

const SSEProgressDrawer = ({ label, onDone }) => {
  const [msg, setMsg] = useState("Processing...");
  const [pct, setPct] = useState(0);

  useEffect(() => {
    // Animate progress while active
    const interval = setInterval(() => {
      setPct(prev => prev < 90 ? prev + 5 : prev);
    }, 1200);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="fixed bottom-4 right-4 z-50 w-80 bg-card border rounded-xl shadow-2xl p-4">
      <p className="text-sm font-medium mb-2">{label}</p>
      <div className="w-full bg-muted rounded-full h-2 mb-2">
        <div className="bg-primary h-2 rounded-full transition-all duration-700" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-xs text-muted-foreground">{msg}</p>
    </div>
  );
};

const useSSETask = () => {
  const [active, setActive] = useState(false);
  const [label, setLabel] = useState("");
  const [cancel, setCancel] = useState(null);

  const startTask = (taskId, lbl, onDone) => {
    setLabel(lbl);
    setActive(true);
    const unsub = subscribeToTask(taskId, (evt) => {
      if (evt.type === "status") {
        if (evt.data?.status === "completed") {
          setActive(false);
          if (onDone) onDone(evt.data);
        } else if (evt.data?.status === "failed") {
          setActive(false);
          toast.error(evt.data?.error || "Task failed");
        }
      }
      if (evt.type === "complete" || evt.type === "done") {
        setActive(false);
        if (onDone) onDone(evt.data);
      }
      if (evt.type === "error") {
        setActive(false);
        toast.error(evt.data?.message || "Task failed");
      }
    });
    setCancel(() => unsub);
  };

  return { active, label, startTask };
};

export default function ProgrammaticSEO() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [pages, setPages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState([]);
  const { active: taskActive, label: taskLabel, startTask } = useSSETask();

  // Service table state
  const [services, setServices] = useState([
    { name: "Plumbing", description: "Professional plumbing services", pricing: "Starting at $99", features: ["24/7 Emergency Service", "Licensed & Insured", "Free Estimates", "Same Day Service"] }
  ]);
  const [newService, setNewService] = useState({ name: "", description: "", pricing: "", features: "" });

  // Location table state
  const [locations, setLocations] = useState([]);
  const [newLocation, setNewLocation] = useState({ cityKey: "", local_keywords: "" });

  useEffect(() => {
    getSites().then(r => {
      setSites(r.data);
      if (r.data.length > 0) setSelectedSite(r.data[0].id);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (selectedSite) loadPages();
  }, [selectedSite]);

  const loadPages = async () => {
    setLoading(true);
    try {
      const r = await listProgrammaticPages(selectedSite);
      setPages(r.data);
    } catch { setPages([]); }
    finally { setLoading(false); }
  };

  const handleAddService = () => {
    if (!newService.name.trim()) return;
    setServices(prev => [...prev, {
      ...newService,
      features: newService.features.split(",").map(f => f.trim()).filter(Boolean)
    }]);
    setNewService({ name: "", description: "", pricing: "", features: "" });
  };

  const handleAddLocation = () => {
    if (!newLocation.cityKey) return toast.error("Select a city");
    const found = CITIES.find(c => `${c.city}, ${c.state}` === newLocation.cityKey);
    if (!found) return;
    if (locations.find(l => l.city === found.city && l.state === found.state))
      return toast.error("City already added");
    setLocations(prev => [...prev, {
      city: found.city,
      state: found.state,
      population: found.population,
      local_keywords: newLocation.local_keywords.split(",").map(k => k.trim()).filter(Boolean),
    }]);
    setNewLocation({ cityKey: "", local_keywords: "" });
  };

  const handleGenerate = async () => {
    if (!selectedSite) return toast.error("Select a site first");
    if (services.length === 0 || locations.length === 0) return toast.error("Add at least one service and location");
    try {
      const r = await generateProgrammaticPages(selectedSite, { services, locations });
      startTask(r.data.task_id, `Generating ${services.length * locations.length} pages...`, () => {
        toast.success("Pages generated!");
        loadPages();
      });
    } catch (e) {
      toast.error(e.response?.data?.detail || "Generation failed");
    }
  };

  const handlePush = async () => {
    if (!selected.length) return toast.error("Select pages to push");
    try {
      const r = await pushProgrammaticPages(selectedSite, { page_ids: selected });
      startTask(r.data.task_id, "Pushing to WordPress...", () => {
        toast.success("Pages pushed to WordPress!");
        setSelected([]);
        loadPages();
      });
    } catch (e) {
      toast.error(e.response?.data?.detail || "Push failed");
    }
  };

  const handleDelete = async (pageId) => {
    try {
      await deleteProgrammaticPage(selectedSite, pageId);
      setPages(prev => prev.filter(p => p.id !== pageId));
      toast.success("Page deleted");
    } catch { toast.error("Delete failed"); }
  };

  const toggleSelect = (id) => setSelected(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  return (
    <motion.div className="page-container" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title flex items-center gap-2"><Layers size={24} />Programmatic SEO</h1>
          <p className="page-description">Generate Service × City landing pages at scale and push to WordPress</p>
        </div>
        <Select value={selectedSite} onValueChange={setSelectedSite}>
          <SelectTrigger className="w-48"><SelectValue placeholder="Select site" /></SelectTrigger>
          <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      <Tabs defaultValue="setup">
        <TabsList className="mb-4">
          <TabsTrigger value="setup">Setup Tables</TabsTrigger>
          <TabsTrigger value="pages">Generated Pages ({pages.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="setup" className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Services Table */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-base flex items-center gap-2"><Wrench size={16} />Services ({services.length})</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {services.map((s, i) => (
                  <div key={i} className="flex items-start justify-between gap-2 p-2 rounded-lg bg-muted/30">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm">{s.name}</p>
                      <p className="text-xs text-muted-foreground truncate">{s.description || "—"}</p>
                      <p className="text-xs text-primary">{s.pricing || "—"}</p>
                    </div>
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-destructive" onClick={() => setServices(prev => prev.filter((_, j) => j !== i))}>
                      <Trash2 size={12} />
                    </Button>
                  </div>
                ))}
                <div className="border-t pt-3 space-y-2">
                  <Input placeholder="Service name *" value={newService.name} onChange={e => setNewService(p => ({ ...p, name: e.target.value }))} />
                  <Input placeholder="Short description" value={newService.description} onChange={e => setNewService(p => ({ ...p, description: e.target.value }))} />
                  <Input placeholder="Pricing (e.g. Starting at $99)" value={newService.pricing} onChange={e => setNewService(p => ({ ...p, pricing: e.target.value }))} />
                  <Input placeholder="Features (comma-separated)" value={newService.features} onChange={e => setNewService(p => ({ ...p, features: e.target.value }))} />
                  <Button size="sm" onClick={handleAddService} className="w-full"><Plus size={14} className="mr-1" />Add Service</Button>
                </div>
              </CardContent>
            </Card>

            {/* Locations Table */}
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-base flex items-center gap-2"><MapPin size={16} />Locations ({locations.length})</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {locations.map((l, i) => (
                  <div key={i} className="flex items-start justify-between gap-2 p-2 rounded-lg bg-muted/30">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm">{l.city}{l.state ? `, ${l.state}` : ""}</p>
                      <p className="text-xs text-muted-foreground">{l.local_keywords?.slice(0,2).join(", ") || "—"}</p>
                    </div>
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-destructive" onClick={() => setLocations(prev => prev.filter((_, j) => j !== i))}>
                      <Trash2 size={12} />
                    </Button>
                  </div>
                ))}
                <div className="border-t pt-3 space-y-2">
                  <Select value={newLocation.cityKey} onValueChange={val => setNewLocation(p => ({ ...p, cityKey: val }))}>
                    <SelectTrigger><SelectValue placeholder="Select a city..." /></SelectTrigger>
                    <SelectContent className="max-h-60">
                      {CITIES.map(c => (
                        <SelectItem key={`${c.city}-${c.state}`} value={`${c.city}, ${c.state}`}>
                          {c.city}, {c.state}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input placeholder="Local keywords (comma-separated, optional)" value={newLocation.local_keywords} onChange={e => setNewLocation(p => ({ ...p, local_keywords: e.target.value }))} />
                  <Button size="sm" onClick={handleAddLocation} className="w-full"><Plus size={14} className="mr-1" />Add Location</Button>
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardContent className="pt-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium">Ready to generate</p>
                  <p className="text-sm text-muted-foreground">{services.length} services × {locations.length} cities = <strong>{services.length * locations.length} landing pages</strong></p>
                  <p className="text-xs text-muted-foreground mt-1">URL pattern: /[service]-in-[city]/ • Includes schema JSON-LD, FAQs, CTAs</p>
                </div>
                <Button onClick={handleGenerate} disabled={!selectedSite || taskActive}>
                  {taskActive ? <><Loader2 size={14} className="mr-2 animate-spin" />Generating...</> : <><Layers size={14} className="mr-2" />Generate All Pages</>}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="pages">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-3">
              <CardTitle className="text-base">Generated Pages</CardTitle>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={loadPages} disabled={loading}>
                  <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
                </Button>
                <Button size="sm" onClick={handlePush} disabled={!selected.length || taskActive}>
                  <Upload size={14} className="mr-2" />Push {selected.length || ""} to WP
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="flex justify-center py-8"><Loader2 className="animate-spin text-muted-foreground" /></div>
              ) : pages.length === 0 ? (
                <p className="text-center py-8 text-muted-foreground">No pages generated yet. Set up tables and click Generate.</p>
              ) : (
                <div className="space-y-2">
                  {pages.map(p => {
                    const site = sites.find(s => s.id === selectedSite);
                    const pageUrl = p.wp_url || (site?.url ? `${site.url.replace(/\/$/, "")}/${p.url_slug}/` : null);
                    return (
                    <div key={p.id} className="flex items-center gap-3 p-3 rounded-lg border hover:bg-muted/30">
                      <Checkbox checked={selected.includes(p.id)} onCheckedChange={() => toggleSelect(p.id)} />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm truncate">{p.title}</p>
                        {pageUrl ? (
                          <a
                            href={pageUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-primary font-mono hover:underline inline-flex items-center gap-1"
                          >
                            {p.url_slug}
                            <ExternalLink size={10} />
                          </a>
                        ) : (
                          <p className="text-xs text-muted-foreground font-mono">{p.url_slug}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {p.pushed_to_wp ? (
                          <Badge className="bg-emerald-500/10 text-emerald-500 text-xs"><CheckCircle2 size={10} className="mr-1" />Pushed</Badge>
                        ) : (
                          <Badge variant="outline" className="text-xs">Draft</Badge>
                        )}
                        <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-destructive" onClick={() => handleDelete(p.id)}>
                          <Trash2 size={12} />
                        </Button>
                      </div>
                    </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {taskActive && (
        <div className="fixed bottom-4 right-4 z-50 w-72 bg-card border rounded-xl shadow-2xl p-4">
          <p className="text-sm font-medium mb-2">{taskLabel}</p>
          <div className="flex items-center gap-2"><Loader2 size={14} className="animate-spin" /><span className="text-xs text-muted-foreground">Processing...</span></div>
        </div>
      )}
    </motion.div>
  );
}
