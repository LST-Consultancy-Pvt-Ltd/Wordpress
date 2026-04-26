import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  ShieldCheck, Loader2, AlertCircle, Search, FileText,
  CheckCircle2, XCircle, AlertTriangle, Eye, Wand2, BarChart3,
  BookOpen, Award, Sparkles, Target, TrendingUp, Brain,
  Layers, HelpCircle, Scale, Globe
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Textarea } from "../components/ui/textarea";
import { Input } from "../components/ui/input";
import { Progress } from "../components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "../components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "../components/ui/table";
import { ScrollArea } from "../components/ui/scroll-area";
import { getSites, getPosts, analyzeAIContent, bulkScanAIContent, fullScoreAIContent, humanizeContent, sectionAIDetection, helpfulContentScore, factCheckContent } from "../lib/api";
import { toast } from "sonner";

const VerdictBadge = ({ score }) => {
  if (score >= 80) return <Badge className="bg-red-500/10 text-red-500 border-red-500/20">Likely AI</Badge>;
  if (score >= 50) return <Badge className="bg-yellow-500/10 text-yellow-500 border-yellow-500/20">Mixed</Badge>;
  return <Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20">Likely Human</Badge>;
};

const scoreColor = (score) => {
  if (score >= 80) return "text-red-500";
  if (score >= 50) return "text-yellow-500";
  return "text-emerald-500";
};

export default function AIContentDetector() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [activeTab, setActiveTab] = useState("text");
  const [text, setText] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState(null);
  // Bulk scan
  const [posts, setPosts] = useState([]);
  const [loadingPosts, setLoadingPosts] = useState(false);
  const [bulkScanning, setBulkScanning] = useState(false);
  const [bulkResults, setBulkResults] = useState([]);
  // Full score
  const [fullScoring, setFullScoring] = useState(false);
  const [fullResult, setFullResult] = useState(null);
  // Humanize
  const [humanizing, setHumanizing] = useState(false);
  const [humanizedText, setHumanizedText] = useState("");
  // Section Analysis
  const [sectionLoading, setSectionLoading] = useState(false);
  const [sectionResults, setSectionResults] = useState(null);
  // Helpful Content
  const [helpfulLoading, setHelpfulLoading] = useState(false);
  const [helpfulResult, setHelpfulResult] = useState(null);
  // Fact Check
  const [factLoading, setFactLoading] = useState(false);
  const [factResult, setFactResult] = useState(null);
  // Competitor Compare
  const [competitorUrl, setCompetitorUrl] = useState("");
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareResult, setCompareResult] = useState(null);

  useEffect(() => {
    getSites().then(r => {
      setSites(r.data);
      if (r.data.length > 0) setSelectedSite(r.data[0].id);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (selectedSite && activeTab === "bulk") loadPosts();
  }, [selectedSite, activeTab]);

  const loadPosts = async () => {
    setLoadingPosts(true);
    try {
      const r = await getPosts(selectedSite);
      setPosts(r.data);
    } catch { setPosts([]); }
    finally { setLoadingPosts(false); }
  };

  const handleAnalyze = async () => {
    if (!text.trim()) { toast.error("Enter text to analyze"); return; }
    setAnalyzing(true);
    setResult(null);
    try {
      const r = await analyzeAIContent(selectedSite, { text: text.trim() });
      setResult(r.data);
      toast.success("Analysis complete");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Analysis failed");
    } finally { setAnalyzing(false); }
  };

  const handleBulkScan = async () => {
    if (!selectedSite) return;
    setBulkScanning(true);
    setBulkResults([]);
    try {
      const r = await bulkScanAIContent(selectedSite, { site_id: selectedSite });
      setBulkResults(r.data?.results || []);
      toast.success(`Scanned ${r.data?.results?.length || 0} posts`);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Bulk scan failed");
    } finally { setBulkScanning(false); }
  };

  const handleFullScore = async () => {
    if (!text.trim()) { toast.error("Enter text to analyze"); return; }
    setFullScoring(true);
    setFullResult(null);
    try {
      const r = await fullScoreAIContent(selectedSite, { text: text.trim() });
      setFullResult(r.data);
      toast.success("Full scoring complete");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Full scoring failed");
    } finally { setFullScoring(false); }
  };

  const handleHumanize = async () => {
    if (!text.trim()) { toast.error("Enter text to humanize"); return; }
    setHumanizing(true);
    setHumanizedText("");
    try {
      const r = await humanizeContent(selectedSite, { text: text.trim() });
      setHumanizedText(r.data?.rewritten || "");
      toast.success("Content humanized");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Humanization failed");
    } finally { setHumanizing(false); }
  };

  const handleSectionAnalysis = async () => {
    if (!text.trim()) { toast.error("Enter text to analyze"); return; }
    setSectionLoading(true);
    setSectionResults(null);
    try {
      const r = await sectionAIDetection(selectedSite, { text: text.trim() });
      setSectionResults(r.data);
      toast.success("Section analysis complete");
    } catch (e) { toast.error(e.response?.data?.detail || "Section analysis failed"); }
    finally { setSectionLoading(false); }
  };

  const handleHelpfulContent = async () => {
    if (!text.trim()) { toast.error("Enter text to analyze"); return; }
    setHelpfulLoading(true);
    setHelpfulResult(null);
    try {
      const r = await helpfulContentScore(selectedSite, { text: text.trim() });
      setHelpfulResult(r.data);
      toast.success("Helpful content check complete");
    } catch (e) { toast.error(e.response?.data?.detail || "Helpful content check failed"); }
    finally { setHelpfulLoading(false); }
  };

  const handleFactCheck = async () => {
    if (!text.trim()) { toast.error("Enter text to fact-check"); return; }
    setFactLoading(true);
    setFactResult(null);
    try {
      const r = await factCheckContent(selectedSite, { text: text.trim(), google_api_key: "" });
      setFactResult(r.data);
      toast.success("Fact check complete");
    } catch (e) { toast.error(e.response?.data?.detail || "Fact check failed"); }
    finally { setFactLoading(false); }
  };

  const handleCompareCompetitor = async () => {
    if (!text.trim()) { toast.error("Enter your content text"); return; }
    if (!competitorUrl.trim()) { toast.error("Enter a competitor URL"); return; }
    setCompareLoading(true);
    setCompareResult(null);
    try {
      const { compareCompetitorContent } = await import("../lib/api");
      const r = await compareCompetitorContent(selectedSite, { your_text: text.trim(), competitor_url: competitorUrl.trim() });
      setCompareResult(r.data);
      toast.success("Comparison complete");
    } catch (e) { toast.error(e.response?.data?.detail || "Comparison failed"); }
    finally { setCompareLoading(false); }
  };

  const ScoreCard = ({ label, score, icon: Icon, color = "text-primary" }) => (
    <div className="flex items-center gap-3 p-3 bg-muted/30 rounded-lg">
      <Icon size={18} className={color} />
      <div className="flex-1 min-w-0">
        <p className="text-xs text-muted-foreground truncate">{label}</p>
        <p className={`text-lg font-bold ${score >= 70 ? "text-emerald-500" : score >= 40 ? "text-yellow-500" : "text-red-500"}`}>{score}/100</p>
      </div>
    </div>
  );

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-heading font-bold flex items-center gap-3">
            <ShieldCheck className="text-primary" /> AI Content Detector
          </h1>
          <p className="text-muted-foreground mt-1">Detect AI-generated content in your posts and text</p>
        </div>
        <Select value={selectedSite} onValueChange={setSelectedSite}>
          <SelectTrigger className="w-[220px]"><SelectValue placeholder="Select site" /></SelectTrigger>
          <SelectContent>
            {sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name || s.url}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="text"><Search size={14} className="mr-1" /> Analyze Text</TabsTrigger>
          <TabsTrigger value="fullscore"><BarChart3 size={14} className="mr-1" /> Full Score</TabsTrigger>
          <TabsTrigger value="humanize"><Wand2 size={14} className="mr-1" /> Humanize</TabsTrigger>
          <TabsTrigger value="bulk"><FileText size={14} className="mr-1" /> Scan Posts</TabsTrigger>
          <TabsTrigger value="sections"><Layers size={14} className="mr-1" /> Section Analysis</TabsTrigger>
          <TabsTrigger value="helpful"><HelpCircle size={14} className="mr-1" /> Helpful Content</TabsTrigger>
          <TabsTrigger value="factcheck"><Scale size={14} className="mr-1" /> Fact Check</TabsTrigger>
          <TabsTrigger value="compare"><Globe size={14} className="mr-1" /> Compare vs Competitor</TabsTrigger>
        </TabsList>

        <TabsContent value="text" className="space-y-4 mt-4">
          <Card>
            <CardHeader><CardTitle>Paste Content</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <Textarea
                placeholder="Paste the text you want to analyze for AI-generated content..."
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={8}
              />
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">{text.length} characters</span>
                <Button onClick={handleAnalyze} disabled={analyzing || !text.trim()}>
                  {analyzing ? <><Loader2 size={14} className="animate-spin mr-2" /> Analyzing...</> : <><ShieldCheck size={14} className="mr-2" /> Analyze</>}
                </Button>
              </div>
            </CardContent>
          </Card>

          {result && (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center justify-between">
                    <span>Detection Results</span>
                    <VerdictBadge score={result.ai_probability} />
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-6">
                  {/* Overall score */}
                  <div className="space-y-2">
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">AI Probability</span>
                      <span className={`font-bold text-lg ${scoreColor(result.ai_probability)}`}>
                        {result.ai_probability}%
                      </span>
                    </div>
                    <Progress value={result.ai_probability} className="h-2" />
                  </div>

                  {/* Sentence breakdown */}
                  {result.sentences && result.sentences.length > 0 && (
                    <div className="space-y-2">
                      <h4 className="text-sm font-medium">Sentence-Level Breakdown</h4>
                      <ScrollArea className="h-64">
                        <div className="space-y-1">
                          {result.sentences.map((s, i) => (
                            <div key={i} className="flex items-start gap-2 text-xs p-2 rounded bg-muted/30">
                              <span className={`font-mono w-8 text-right shrink-0 ${scoreColor(s.score)}`}>{s.score}%</span>
                              <span className="text-muted-foreground">{s.text}</span>
                            </div>
                          ))}
                        </div>
                      </ScrollArea>
                    </div>
                  )}

                  {/* Suggestions */}
                  {result.suggestions && result.suggestions.length > 0 && (
                    <div className="space-y-2">
                      <h4 className="text-sm font-medium">Humanization Suggestions</h4>
                      <ul className="space-y-1">
                        {result.suggestions.map((s, i) => (
                          <li key={i} className="flex items-start gap-2 text-sm text-muted-foreground">
                            <AlertTriangle size={14} className="text-yellow-500 mt-0.5 shrink-0" />
                            {s}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </CardContent>
              </Card>
            </motion.div>
          )}
        </TabsContent>

        {/* Full Score Tab — Module 10 Complete Scoring */}
        <TabsContent value="fullscore" className="space-y-4 mt-4">
          <Card>
            <CardHeader><CardTitle>Comprehensive Content Scoring</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <Textarea
                placeholder="Paste content for full AI Detection + EEAT + Readability + Originality + Content Depth scoring..."
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={6}
              />
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">{text.length} characters</span>
                <Button onClick={handleFullScore} disabled={fullScoring || !text.trim()}>
                  {fullScoring ? <><Loader2 size={14} className="animate-spin mr-2" /> Scoring...</> : <><BarChart3 size={14} className="mr-2" /> Run Full Score</>}
                </Button>
              </div>
            </CardContent>
          </Card>

          {fullResult && (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
              {/* Composite Score */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center justify-between">
                    <span>Composite Score</span>
                    <Badge className={`text-lg px-3 py-1 ${fullResult.composite_score?.overall_grade === "A" ? "bg-emerald-500/10 text-emerald-500" : fullResult.composite_score?.overall_grade === "B" ? "bg-blue-500/10 text-blue-500" : fullResult.composite_score?.overall_grade === "C" ? "bg-yellow-500/10 text-yellow-500" : "bg-red-500/10 text-red-500"}`}>
                      Grade {fullResult.composite_score?.overall_grade || "?"}
                    </Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    <ScoreCard label="Publish Readiness" score={fullResult.composite_score?.publish_readiness || 0} icon={CheckCircle2} />
                    <ScoreCard label="Human Quality" score={fullResult.composite_score?.human_quality || 0} icon={Award} />
                    <ScoreCard label="AI Probability" score={100 - (fullResult.ai_detection?.ai_probability || 0)} icon={ShieldCheck} />
                  </div>
                  {fullResult.composite_score?.top_improvements && (
                    <div className="mt-4 space-y-1">
                      <h4 className="text-sm font-medium">Top Improvements</h4>
                      {fullResult.composite_score.top_improvements.map((t, i) => (
                        <p key={i} className="text-xs text-muted-foreground flex items-start gap-2">
                          <TrendingUp size={12} className="text-yellow-500 mt-0.5 shrink-0" /> {t}
                        </p>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Detailed Scores Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* AI Detection */}
                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-sm">AI Detection</CardTitle></CardHeader>
                  <CardContent className="space-y-2">
                    <div className="flex justify-between text-sm">
                      <span>AI Probability</span>
                      <span className={`font-bold ${scoreColor(fullResult.ai_detection?.ai_probability || 0)}`}>{fullResult.ai_detection?.ai_probability || 0}%</span>
                    </div>
                    <Progress value={fullResult.ai_detection?.ai_probability || 0} className="h-1.5" />
                    <div className="flex gap-2 text-xs text-muted-foreground">
                      <span>Perplexity: {fullResult.ai_detection?.perplexity_assessment}</span>
                      <span>•</span>
                      <span>Burstiness: {fullResult.ai_detection?.burstiness_assessment}</span>
                    </div>
                  </CardContent>
                </Card>

                {/* EEAT */}
                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-sm">E-E-A-T Score</CardTitle></CardHeader>
                  <CardContent className="space-y-2">
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      {["experience", "expertise", "authority", "trust"].map(k => (
                        <div key={k} className="flex justify-between">
                          <span className="capitalize">{k}</span>
                          <span className={`font-bold ${(fullResult.eeat?.[`${k}_score`] || 0) >= 60 ? "text-emerald-500" : "text-red-500"}`}>{fullResult.eeat?.[`${k}_score`] || 0}</span>
                        </div>
                      ))}
                    </div>
                    {fullResult.eeat?.missing_signals?.length > 0 && (
                      <div className="text-xs text-muted-foreground mt-1">
                        Missing: {fullResult.eeat.missing_signals.join(", ")}
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Readability */}
                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-sm">Readability</CardTitle></CardHeader>
                  <CardContent className="space-y-1 text-xs">
                    <div className="flex justify-between"><span>Flesch Score</span><span className="font-bold">{fullResult.readability?.flesch_score || 0}</span></div>
                    <div className="flex justify-between"><span>Grade Level</span><span>{fullResult.readability?.grade_level || "?"}</span></div>
                    <div className="flex justify-between"><span>Passive Voice</span><span>{fullResult.readability?.passive_voice_percentage || 0}%</span></div>
                    <div className="flex justify-between"><span>Avg Sentence Length</span><span>{fullResult.readability?.avg_sentence_length || 0} words</span></div>
                  </CardContent>
                </Card>

                {/* Humanization */}
                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-sm">Humanization</CardTitle></CardHeader>
                  <CardContent className="space-y-1 text-xs">
                    <div className="flex justify-between"><span>Overall Score</span><span className="font-bold">{fullResult.humanization?.score || 0}/100</span></div>
                    <div className="flex justify-between"><span>Natural Phrasing</span><span>{fullResult.humanization?.natural_phrasing || 0}/100</span></div>
                    <div className="flex justify-between"><span>Sentence Variation</span><span>{fullResult.humanization?.sentence_variation || 0}/100</span></div>
                    {fullResult.humanization?.generic_ai_phrases_found?.length > 0 && (
                      <div className="text-red-400 mt-1">AI phrases: {fullResult.humanization.generic_ai_phrases_found.join(", ")}</div>
                    )}
                  </CardContent>
                </Card>

                {/* Content Depth */}
                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-sm">Content Depth</CardTitle></CardHeader>
                  <CardContent className="space-y-1 text-xs">
                    <div className="flex justify-between"><span>Depth Score</span><span className="font-bold">{fullResult.content_depth?.score || 0}/100</span></div>
                    <div className="flex justify-between"><span>Word Count</span><span>{fullResult.content_depth?.word_count || 0}</span></div>
                    <div className="flex justify-between"><span>Topic Coverage</span><span className="capitalize">{fullResult.content_depth?.topic_coverage || "?"}</span></div>
                    <div className="flex justify-between"><span>Entities Found</span><span>{fullResult.content_depth?.entity_count || 0}</span></div>
                  </CardContent>
                </Card>

                {/* Semantic Richness */}
                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-sm">Semantic Richness</CardTitle></CardHeader>
                  <CardContent className="space-y-1 text-xs">
                    <div className="flex justify-between"><span>Score</span><span className="font-bold">{fullResult.semantic_richness?.score || 0}/100</span></div>
                    <div className="flex justify-between"><span>LSI Keywords</span><span className="capitalize">{fullResult.semantic_richness?.lsi_keyword_usage || "?"}</span></div>
                    <div className="flex justify-between"><span>Contextual Relevance</span><span>{fullResult.semantic_richness?.contextual_relevance || 0}/100</span></div>
                    <div className="flex justify-between"><span>Entity Diversity</span><span>{fullResult.semantic_richness?.entity_diversity || 0}/100</span></div>
                  </CardContent>
                </Card>

                {/* Engagement Prediction */}
                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-sm">Engagement Prediction</CardTitle></CardHeader>
                  <CardContent className="space-y-1 text-xs">
                    <div className="flex justify-between"><span>Score</span><span className="font-bold">{fullResult.engagement_prediction?.score || 0}/100</span></div>
                    <div className="flex justify-between"><span>Read Time</span><span>{fullResult.engagement_prediction?.estimated_read_time_minutes || 0} min</span></div>
                    <div className="flex justify-between"><span>Hook Strength</span><span className="capitalize">{fullResult.engagement_prediction?.hook_strength || "?"}</span></div>
                    <div className="flex justify-between"><span>Shareability</span><span className="capitalize">{fullResult.engagement_prediction?.shareability || "?"}</span></div>
                  </CardContent>
                </Card>

                {/* Fact Accuracy */}
                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-sm">Fact Accuracy</CardTitle></CardHeader>
                  <CardContent className="space-y-1 text-xs">
                    <div className="flex justify-between"><span>Score</span><span className="font-bold">{fullResult.fact_accuracy?.score || 0}/100</span></div>
                    <div className="flex justify-between"><span>Unsupported Claims</span><span>{fullResult.fact_accuracy?.unsupported_claims || 0}</span></div>
                    <div className="flex justify-between"><span>Freshness</span><span className="capitalize">{fullResult.fact_accuracy?.freshness || "?"}</span></div>
                    <div className="flex justify-between"><span>Needs Update</span><span>{fullResult.fact_accuracy?.needs_update ? "Yes" : "No"}</span></div>
                  </CardContent>
                </Card>

                {/* Originality */}
                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-sm">Originality</CardTitle></CardHeader>
                  <CardContent className="space-y-1 text-xs">
                    <div className="flex justify-between"><span>Score</span><span className="font-bold">{fullResult.originality?.score || 0}/100</span></div>
                    <div className="flex justify-between"><span>Duplicate Risk</span><span className="capitalize">{fullResult.originality?.duplicate_risk || "?"}</span></div>
                    <div className="flex justify-between"><span>Paraphrase Detection</span><span className="capitalize">{fullResult.originality?.paraphrase_detection || "?"}</span></div>
                  </CardContent>
                </Card>

                {/* SEO Compatibility */}
                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-sm">SEO Compatibility</CardTitle></CardHeader>
                  <CardContent className="space-y-1 text-xs">
                    <div className="flex justify-between"><span>Score</span><span className="font-bold">{fullResult.seo_compatibility?.score || 0}/100</span></div>
                    <div className="flex justify-between"><span>Heading Structure</span><span className="capitalize">{fullResult.seo_compatibility?.heading_structure || "?"}</span></div>
                    <div className="flex justify-between"><span>Keyword Integration</span><span className="capitalize">{fullResult.seo_compatibility?.keyword_integration || "?"}</span></div>
                    <div className="flex justify-between"><span>Meta Ready</span><span>{fullResult.seo_compatibility?.meta_readiness ? "Yes" : "No"}</span></div>
                  </CardContent>
                </Card>
              </div>
            </motion.div>
          )}
        </TabsContent>

        {/* Humanize Tab */}
        <TabsContent value="humanize" className="space-y-4 mt-4">
          <Card>
            <CardHeader><CardTitle>AI Content Humanizer</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <Textarea
                placeholder="Paste AI-generated content to humanize..."
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={6}
              />
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">{text.length} characters</span>
                <Button onClick={handleHumanize} disabled={humanizing || !text.trim()}>
                  {humanizing ? <><Loader2 size={14} className="animate-spin mr-2" /> Humanizing...</> : <><Wand2 size={14} className="mr-2" /> Humanize Content</>}
                </Button>
              </div>
            </CardContent>
          </Card>
          {humanizedText && (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center justify-between">
                    <span>Humanized Result</span>
                    <Button size="sm" variant="outline" onClick={() => { navigator.clipboard.writeText(humanizedText); toast.success("Copied!"); }}>
                      Copy
                    </Button>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <ScrollArea className="h-80">
                    <div className="prose prose-invert max-w-none text-sm whitespace-pre-wrap">{humanizedText}</div>
                  </ScrollArea>
                </CardContent>
              </Card>
            </motion.div>
          )}
        </TabsContent>

        <TabsContent value="bulk" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                <span>Bulk Post Scan</span>
                <Button onClick={handleBulkScan} disabled={bulkScanning || !selectedSite}>
                  {bulkScanning ? <><Loader2 size={14} className="animate-spin mr-2" /> Scanning...</> : <><Eye size={14} className="mr-2" /> Scan All Posts</>}
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {bulkResults.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Post</TableHead>
                      <TableHead className="w-[100px]">AI Score</TableHead>
                      <TableHead className="w-[100px]">Verdict</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {bulkResults.map((r, i) => (
                      <TableRow key={i}>
                        <TableCell className="font-medium">{r.title}</TableCell>
                        <TableCell>
                          <span className={`font-mono font-bold ${scoreColor(r.ai_probability)}`}>{r.ai_probability}%</span>
                        </TableCell>
                        <TableCell><VerdictBadge score={r.ai_probability} /></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <div className="text-center text-muted-foreground py-12">
                  {bulkScanning ? (
                    <Loader2 size={24} className="animate-spin mx-auto mb-2" />
                  ) : (
                    <ShieldCheck size={24} className="mx-auto mb-2 opacity-40" />
                  )}
                  <p>{bulkScanning ? "Scanning posts..." : "Click 'Scan All Posts' to detect AI content across your site"}</p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Section Analysis Tab */}
        <TabsContent value="sections" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                <span>Section-by-Section AI Analysis</span>
                <Button onClick={handleSectionAnalysis} disabled={sectionLoading || !text.trim()}>
                  {sectionLoading ? <><Loader2 size={14} className="animate-spin mr-2" /> Analyzing...</> : <><Layers size={14} className="mr-2" /> Analyze by Section</>}
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {sectionLoading ? (
                <div className="flex justify-center py-8"><Loader2 size={24} className="animate-spin text-primary" /></div>
              ) : sectionResults ? (
                <div className="space-y-3">
                  <div className="p-3 bg-muted/30 rounded-lg text-sm">
                    {(sectionResults.sections || []).length} sections analyzed, avg AI probability: {Math.round((sectionResults.sections || []).reduce((s, x) => s + (x.ai_probability || 0), 0) / Math.max((sectionResults.sections || []).length, 1))}%
                  </div>
                  {(sectionResults.sections || []).map((sec, i) => {
                    const prob = sec.ai_probability || 0;
                    const color = prob > 70 ? "text-red-500" : prob > 30 ? "text-yellow-500" : "text-emerald-500";
                    const bgColor = prob > 70 ? "bg-red-500" : prob > 30 ? "bg-yellow-500" : "bg-emerald-500";
                    const label = prob > 70 ? "AI-generated" : prob > 30 ? "Mixed" : "Human-like";
                    const risk = prob > 70 ? "high" : prob > 30 ? "medium" : "low";
                    return (
                      <Card key={i} className="border-border/40">
                        <CardContent className="pt-4 space-y-2">
                          <div className="flex items-center justify-between">
                            <h4 className="text-sm font-medium">{sec.heading || sec.section || `Section ${i + 1}`}</h4>
                            <div className="flex items-center gap-2">
                              <Badge className={`text-xs ${prob > 70 ? "bg-red-500/10 text-red-500" : prob > 30 ? "bg-yellow-500/10 text-yellow-500" : "bg-emerald-500/10 text-emerald-500"}`}>{label}</Badge>
                              <Badge variant="outline" className="text-xs">{risk} risk</Badge>
                            </div>
                          </div>
                          <div className="flex items-center gap-3">
                            <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                              <div className={`h-full ${bgColor} rounded-full`} style={{ width: `${prob}%` }} />
                            </div>
                            <span className={`text-sm font-bold ${color}`}>{prob}%</span>
                          </div>
                          <p className="text-xs text-muted-foreground">{sec.word_count || 0} words</p>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  Enter text in the "Analyze Text" tab, then click "Analyze by Section" to see per-section results
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Helpful Content Tab */}
        <TabsContent value="helpful" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                <span>Google Helpful Content Compliance</span>
                <Button onClick={handleHelpfulContent} disabled={helpfulLoading || !text.trim()}>
                  {helpfulLoading ? <><Loader2 size={14} className="animate-spin mr-2" /> Checking...</> : <><HelpCircle size={14} className="mr-2" /> Check Helpful Content Compliance</>}
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {helpfulLoading ? (
                <div className="flex justify-center py-8"><Loader2 size={24} className="animate-spin text-primary" /></div>
              ) : helpfulResult ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    {[
                      { label: "People-First Score", value: helpfulResult.people_first_score },
                      { label: "Original Analysis", value: helpfulResult.original_analysis_score || helpfulResult.originality_score },
                      { label: "First-Hand Expertise", value: helpfulResult.first_hand_expertise_score || helpfulResult.expertise_score },
                      { label: "Overall Helpful Score", value: helpfulResult.overall_score || helpfulResult.helpful_score, highlight: true },
                    ].map((item, i) => (
                      <Card key={i} className={item.highlight ? "border-primary/40" : ""}>
                        <CardContent className="p-4 text-center">
                          <p className={`text-3xl font-bold ${(item.value || 0) >= 70 ? "text-emerald-500" : (item.value || 0) >= 40 ? "text-yellow-500" : "text-red-500"}`}>
                            {item.value || 0}<span className="text-sm text-muted-foreground">/100</span>
                          </p>
                          <p className="text-xs text-muted-foreground mt-1">{item.label}</p>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                  <div className="flex justify-center">
                    {(helpfulResult.overall_score || helpfulResult.helpful_score || 0) >= 70 ? (
                      <Badge className="bg-emerald-500/10 text-emerald-500 text-sm px-4 py-1">✓ Passes Helpful Content Guidelines</Badge>
                    ) : (helpfulResult.overall_score || helpfulResult.helpful_score || 0) >= 40 ? (
                      <Badge className="bg-yellow-500/10 text-yellow-500 text-sm px-4 py-1">⚠ Borderline — Improvements Needed</Badge>
                    ) : (
                      <Badge className="bg-red-500/10 text-red-500 text-sm px-4 py-1">✗ Fails Helpful Content Guidelines</Badge>
                    )}
                  </div>
                  {helpfulResult.suggestions?.length > 0 && (
                    <div>
                      <h4 className="text-sm font-medium mb-2">Improvement Suggestions</h4>
                      <ul className="space-y-1">
                        {helpfulResult.suggestions.map((s, i) => (
                          <li key={i} className="text-sm text-muted-foreground flex items-start gap-2">
                            <TrendingUp size={12} className="text-yellow-500 mt-1 shrink-0" /> {s}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {helpfulResult.missing_signals?.length > 0 && (
                    <div>
                      <h4 className="text-sm font-medium mb-2">Missing Signals</h4>
                      <ul className="space-y-1">
                        {helpfulResult.missing_signals.map((s, i) => (
                          <li key={i} className="text-sm text-red-400 flex items-start gap-2">
                            <XCircle size={12} className="mt-1 shrink-0" /> {s}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  Enter text in the "Analyze Text" tab, then check Helpful Content compliance
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Fact Check Tab */}
        <TabsContent value="factcheck" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                <span>Fact Check</span>
                <Button onClick={handleFactCheck} disabled={factLoading || !text.trim()}>
                  {factLoading ? <><Loader2 size={14} className="animate-spin mr-2" /> Checking...</> : <><Scale size={14} className="mr-2" /> Check Facts</>}
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {factLoading ? (
                <div className="flex justify-center py-8"><Loader2 size={24} className="animate-spin text-primary" /></div>
              ) : factResult ? (
                <div className="space-y-4">
                  <div className="flex items-center gap-2">
                    {factResult.api_used === "google" || factResult.api_used === "google_fact_check" ? (
                      <Badge className="bg-emerald-500/10 text-emerald-500 text-xs">Live Google API</Badge>
                    ) : (
                      <Badge className="bg-yellow-500/10 text-yellow-500 text-xs">AI Estimated</Badge>
                    )}
                  </div>

                  {(() => {
                    const claims = factResult.claims || [];
                    const verified = claims.filter(c => c.verdict === "verified" || c.verdict === "true" || c.rating === "verified").length;
                    const disputed = claims.filter(c => c.verdict === "disputed" || c.verdict === "false" || c.rating === "disputed").length;
                    const unverified = claims.length - verified - disputed;
                    return (
                      <>
                        <div className="p-3 bg-muted/30 rounded-lg text-sm">
                          {claims.length} claims checked, <span className="text-emerald-500">{verified} verified</span>, <span className="text-red-500">{disputed} disputed</span>, <span className="text-muted-foreground">{unverified} unverified</span>
                        </div>
                        {claims.length === 0 ? (
                          <div className="text-center py-8 text-muted-foreground text-sm">
                            No checkable factual claims detected in this content
                          </div>
                        ) : (
                          <div className="space-y-2">
                            {claims.map((c, i) => {
                              const v = (c.verdict || c.rating || "unverified").toLowerCase();
                              const isVerified = v === "verified" || v === "true";
                              const isDisputed = v === "disputed" || v === "false";
                              return (
                                <Card key={i} className={`border-border/40 ${isDisputed ? "bg-red-500/5" : ""}`}>
                                  <CardContent className="p-3 space-y-1">
                                    <p className="text-sm italic">"{c.claim || c.text}"</p>
                                    <div className="flex items-center gap-2">
                                      {isVerified ? (
                                        <Badge className="bg-emerald-500/10 text-emerald-500 text-xs">Verified ✓</Badge>
                                      ) : isDisputed ? (
                                        <Badge className="bg-red-500/10 text-red-500 text-xs">Disputed ✗</Badge>
                                      ) : (
                                        <Badge className="bg-muted text-muted-foreground text-xs">Unverified ?</Badge>
                                      )}
                                      {c.source && <span className="text-xs text-muted-foreground">Source: {c.source}</span>}
                                    </div>
                                  </CardContent>
                                </Card>
                              );
                            })}
                          </div>
                        )}
                      </>
                    );
                  })()}
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  Enter text in the "Analyze Text" tab, then click "Check Facts"
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Compare vs Competitor Tab */}
        <TabsContent value="compare" className="space-y-4 mt-4">
          <Card>
            <CardHeader><CardTitle>Compare vs Competitor Content</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <Textarea
                placeholder="Paste your content here..."
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={6}
              />
              <Input
                placeholder="Competitor URL to compare against (e.g. https://example.com/article)"
                value={competitorUrl}
                onChange={(e) => setCompetitorUrl(e.target.value)}
              />
              <Button onClick={handleCompareCompetitor} disabled={compareLoading || !text.trim() || !competitorUrl.trim()}>
                {compareLoading ? <><Loader2 size={14} className="animate-spin mr-2" /> Fetching competitor content and comparing...</> : <><Globe size={14} className="mr-2" /> Compare Content</>}
              </Button>
            </CardContent>
          </Card>

          {compareResult && (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {[
                  { label: "Your Content", data: compareResult.your_content },
                  { label: "Competitor", data: compareResult.competitor_content },
                ].map((col, ci) => (
                  <Card key={ci}>
                    <CardHeader className="pb-2"><CardTitle className="text-sm">{col.label}</CardTitle></CardHeader>
                    <CardContent className="space-y-2 text-xs">
                      {[
                        { l: "Depth Score", v: col.data?.depth_score },
                        { l: "Topic Coverage", v: col.data?.topic_coverage },
                        { l: "Readability", v: col.data?.readability },
                        { l: "Word Count", v: col.data?.word_count, noScore: true },
                        { l: "AI Probability", v: col.data?.ai_probability, suffix: "%" },
                      ].map((m, j) => (
                        <div key={j} className="flex justify-between">
                          <span>{m.l}</span>
                          <span className={`font-bold ${!m.noScore && !m.suffix ? ((m.v || 0) >= 60 ? "text-emerald-500" : "text-red-500") : ""}`}>
                            {m.v != null ? `${m.v}${m.suffix || (m.noScore ? "" : "/100")}` : "—"}
                          </span>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                ))}
              </div>

              {compareResult.gaps?.length > 0 && (
                <Card className="border-red-500/30">
                  <CardHeader className="pb-2"><CardTitle className="text-sm text-red-400">Content Gaps</CardTitle></CardHeader>
                  <CardContent>
                    <ul className="space-y-1">
                      {compareResult.gaps.map((g, i) => (
                        <li key={i} className="text-sm text-red-400 flex items-start gap-2">
                          <XCircle size={12} className="mt-1 shrink-0" /> {g}
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              )}

              {compareResult.advantages?.length > 0 && (
                <Card className="border-emerald-500/30">
                  <CardHeader className="pb-2"><CardTitle className="text-sm text-emerald-500">Your Advantages</CardTitle></CardHeader>
                  <CardContent>
                    <ul className="space-y-1">
                      {compareResult.advantages.map((a, i) => (
                        <li key={i} className="text-sm text-emerald-500 flex items-start gap-2">
                          <CheckCircle2 size={12} className="mt-1 shrink-0" /> {a}
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              )}

              {compareResult.verdict && (
                <div className={`p-3 rounded-lg text-sm text-center font-medium ${
                  compareResult.verdict.toLowerCase().includes("stronger") ? "bg-emerald-500/10 text-emerald-500" :
                  compareResult.verdict.toLowerCase().includes("weaker") ? "bg-red-500/10 text-red-500" :
                  "bg-yellow-500/10 text-yellow-500"
                }`}>
                  {compareResult.verdict}
                </div>
              )}

              {compareResult.recommendations?.length > 0 && (
                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-sm">Recommendations</CardTitle></CardHeader>
                  <CardContent>
                    <ol className="space-y-1 list-decimal list-inside">
                      {compareResult.recommendations.map((r, i) => (
                        <li key={i} className="text-sm text-muted-foreground">{r}</li>
                      ))}
                    </ol>
                  </CardContent>
                </Card>
              )}
            </motion.div>
          )}
        </TabsContent>
      </Tabs>
    </motion.div>
  );
}
