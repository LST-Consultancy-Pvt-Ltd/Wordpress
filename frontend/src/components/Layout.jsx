import { useState, useEffect, useCallback } from "react";
import { Outlet, NavLink, useLocation, useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  LayoutDashboard,
  Globe,
  Sparkles,
  FileText,
  Newspaper,
  Search,
  Menu as MenuIcon,
  RefreshCw,
  Settings,
  Activity,
  Link2,
  Copy,
  CalendarDays,
  X,
  ChevronRight,
  Zap,
  LogOut,
  User,
  Eye,
  Target,
  Gauge,
  Network,
  BarChart3,
  MapPin,
  PenTool,
  LayoutGrid,
  Bug,
  Bot,
  Image,
  MessageSquare,
  Users,
  Puzzle,
  ShoppingCart,
  FileInput,
  Archive,
  ArrowRightLeft,
  FlaskConical,
  Share2,

  HeartPulse,
  Bell,
  Command,

  Hash,
  Star,
  DollarSign,
  PenLine,

  Code2,
  Map,
  GitMerge,
  Smartphone,
  ShieldCheck,
  Megaphone,
  LinkIcon,
  ExternalLink,
  TrendingUp,

  Bookmark,
  Compass,
  Clock,
  AlertTriangle,
  Radio,
  Store,
  Mic,
  Mail,
  Layers,
} from "lucide-react";
import { Button } from "./ui/button";
import { Sheet, SheetContent, SheetTrigger } from "./ui/sheet";
import { ScrollArea } from "./ui/scroll-area";
import { Badge } from "./ui/badge";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./ui/command";
import { getNotifications, markAllNotificationsRead } from "../lib/api";
import { useApplyMode } from "../hooks/useApplyMode";

const navGroups = [
  // Module 11 — Connected Sites Dashboard
  {
    label: null,
    items: [
      { path: "/", icon: LayoutDashboard, label: "Dashboard" },
      { path: "/sites", icon: Globe, label: "Sites" },
      { path: "/ai-command", icon: Sparkles, label: "AI Command" },
      { path: "/autopilot", icon: Bot, label: "Autopilot" },
    ],
  },
  // Module 12 — AI SEO Autopilot Pipeline & AI Tools
  {
    label: "AI Tools",
    items: [
      { path: "/ai-content-detector", icon: ShieldCheck, label: "AI Content Detector" },
      { path: "/keyword-research", icon: Search, label: "Keyword Research" },
      { path: "/auto-blog-generation", icon: Bot, label: "Auto Blog Generation" },
      { path: "/keyword-analysis", icon: BarChart3, label: "Keyword Analysis" },
      { path: "/programmatic-seo", icon: Layers, label: "Programmatic SEO" },
    ],
  },
  // Module 1 — Keyword Module + Module 2 — SEO Metrics + Module 6 — Extra SEO
  {
    label: "SEO & Analytics",
    items: [
      { path: "/seo", icon: Search, label: "SEO" },
      { path: "/search-visibility", icon: Eye, label: "Search Visibility" },
      { path: "/keyword-tracking", icon: Target, label: "Keyword Tracking" },
      { path: "/keyword-clusters", icon: Hash, label: "Keyword Clusters" },
      { path: "/site-speed", icon: Gauge, label: "Site Speed" },
      { path: "/link-builder", icon: Network, label: "Link Builder" },
      { path: "/broken-links", icon: Link2, label: "Broken Links" },
      { path: "/duplicate-content", icon: Copy, label: "Duplicate Content" },
      { path: "/crawl-report", icon: Bug, label: "Crawl Report" },
      { path: "/schema-markup", icon: Code2, label: "Schema Markup" },
      { path: "/sitemap-robots", icon: Map, label: "Sitemap & Robots" },
      { path: "/canonical-manager", icon: GitMerge, label: "Canonical Manager" },
      { path: "/mobile-checker", icon: Smartphone, label: "Mobile Checker" },
      { path: "/indexing-tracker", icon: Compass, label: "Indexing Tracker" },
      { path: "/reports", icon: BarChart3, label: "Reports" },
      { path: "/report-builder", icon: LayoutGrid, label: "Report Builder" },
      { path: "/revenue-dashboard", icon: DollarSign, label: "Revenue Dashboard" },
    ],
  },
  // Module 9 — Off-Page SEO & Backlinks
  {
    label: "Off-Page SEO",
    items: [
      { path: "/backlink-outreach", icon: ExternalLink, label: "Backlink Outreach" },
      { path: "/guest-posting", icon: PenLine, label: "Guest Posting" },
      { path: "/brand-mentions", icon: Megaphone, label: "Brand Mentions" },
      { path: "/link-reclamation", icon: LinkIcon, label: "Link Reclamation" },
      { path: "/digital-pr", icon: Radio, label: "Digital PR" },
      { path: "/community-engagement", icon: Users, label: "Community Engagement" },
      { path: "/podcast-outreach", icon: Mic, label: "Podcast Outreach" },
      { path: "/offpage-autopilot", icon: Zap, label: "Off-Page Autopilot" },
    ],
  },
  // Module 5 — Local SEO
  {
    label: "Local SEO",
    items: [
      { path: "/local-tracking", icon: MapPin, label: "Local Tracking" },
      { path: "/local-citations", icon: Bookmark, label: "Local Citations" },
      { path: "/gbp-optimizer", icon: Map, label: "GBP Optimizer" },
      { path: "/review-growth", icon: Star, label: "Review Growth" },
    ],
  },
  // Module 3 — Uptime & Module 8 — Site Health
  {
    label: "Health & Uptime",
    items: [
      { path: "/site-health", icon: HeartPulse, label: "Site Health" },
      { path: "/activity", icon: Activity, label: "Activity" },
    ],
  },
  // Module 5 — Content
  {
    label: "Content",
    items: [
      { path: "/pages", icon: FileText, label: "Pages" },
      { path: "/posts", icon: Newspaper, label: "Posts" },
      { path: "/calendar", icon: CalendarDays, label: "Calendar" },
      { path: "/content-refresh", icon: RefreshCw, label: "Content Refresh" },
      { path: "/live-editor", icon: PenTool, label: "Live Editor" },
    ],
  },
  // WordPress Integration
  {
    label: "WordPress",
    items: [
      { path: "/media-library", icon: Image, label: "Media Library" },
      { path: "/comments", icon: MessageSquare, label: "Comments" },
      { path: "/wp-users", icon: Users, label: "Users" },
      { path: "/plugins-themes", icon: Puzzle, label: "Plugins & Themes" },
      { path: "/forms", icon: FileInput, label: "Forms" },
      { path: "/navigation", icon: MenuIcon, label: "Navigation" },
      { path: "/backups", icon: Archive, label: "Backups" },
      { path: "/redirects", icon: ArrowRightLeft, label: "Redirects" },
      { path: "/woocommerce", icon: Store, label: "WooCommerce" },
    ],
  },
  // Module 7 — Social Media & Marketing
  {
    label: "Marketing",
    items: [
      { path: "/social-media", icon: Share2, label: "Social Media" },
      { path: "/newsletter", icon: Mail, label: "Newsletter" },
      { path: "/influencer-outreach", icon: Star, label: "Influencer Outreach" },
      { path: "/ab-testing", icon: FlaskConical, label: "A/B Testing" },
    ],
  },
  {
    label: null,
    items: [
      { path: "/settings", icon: Settings, label: "Settings" },
    ],
  },
];

// Flat list for CMD+K search
const allNavItems = navGroups.flatMap(g => g.items);

const NavItem = ({ item, isActive, onClick }) => (
  <NavLink
    to={item.path}
    onClick={onClick}
    className={`flex items-center gap-3 px-4 py-2.5 rounded-md text-sm font-medium transition-all duration-200 ${
      isActive
        ? "bg-primary/10 text-primary ai-glow"
        : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
    }`}
    data-testid={`nav-${item.label.toLowerCase().replace(/\s+/g, '-')}`}
  >
    <item.icon size={18} strokeWidth={1.5} />
    <span>{item.label}</span>
    {isActive && (
      <ChevronRight size={14} className="ml-auto text-primary" />
    )}
  </NavLink>
);

const Sidebar = ({ className = "", onNavClick, notifications = [], onOpenSearch }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const user = (() => { try { return JSON.parse(localStorage.getItem("wp_user") || "null"); } catch { return null; } })();
  const unread = notifications.filter(n => !n.read).length;
  const { applyMode, setApplyMode } = useApplyMode();

  const handleLogout = () => {
    localStorage.removeItem("wp_token");
    localStorage.removeItem("wp_user");
    navigate("/login");
  };

  return (
    <div className={`flex flex-col h-full ${className}`}>
      {/* Logo + top actions */}
      <div className="p-6 border-b border-border/30">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center ai-pulse">
            <Zap size={22} className="text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="font-heading font-bold text-lg text-foreground">WP Autopilot</h1>
            <p className="text-xs text-muted-foreground">AI Website Manager</p>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" className="relative h-8 w-8" onClick={onOpenSearch} title="Search (⌘K)">
              <Search size={15} className="text-muted-foreground" />
            </Button>
            <Button variant="ghost" size="icon" className="relative h-8 w-8" title="Notifications">
              <Bell size={15} className="text-muted-foreground" />
              {unread > 0 && (
                <span className="absolute -top-0.5 -right-0.5 h-4 w-4 rounded-full bg-primary text-[9px] flex items-center justify-center text-primary-foreground font-bold">
                  {unread > 9 ? "9+" : unread}
                </span>
              )}
            </Button>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <ScrollArea className="flex-1 px-3 py-4">
        <nav className="space-y-0.5">
          {navGroups.map((group, gi) => (
            <div key={gi} className={gi > 0 ? "mt-4" : ""}>
              {group.label && (
                <p className="px-4 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-1">
                  {group.label}
                </p>
              )}
              {group.items.map(item => (
                <NavItem
                  key={item.path}
                  item={item}
                  isActive={location.pathname === item.path}
                  onClick={onNavClick}
                />
              ))}
            </div>
          ))}
        </nav>
      </ScrollArea>

      {/* Footer */}
      <div className="p-4 border-t border-border/30 space-y-3">
        {/* Apply Mode Toggle */}
        <div className="bg-muted/40 rounded-lg p-3 border border-border/40">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-medium text-foreground">Apply Mode</span>
            {applyMode === "manual" && (
              <span className="text-[10px] font-semibold bg-yellow-500/15 text-yellow-600 border border-yellow-500/30 rounded px-1.5 py-0.5">
                Manual
              </span>
            )}
          </div>
          <div className="flex gap-1">
            <button
              onClick={() => setApplyMode("automatic")}
              className={`flex-1 text-xs py-1.5 rounded-md font-medium transition-all ${
                applyMode === "automatic"
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
              }`}
            >
              Automatic
            </button>
            <button
              onClick={() => setApplyMode("manual")}
              className={`flex-1 text-xs py-1.5 rounded-md font-medium transition-all ${
                applyMode === "manual"
                  ? "bg-yellow-500 text-white shadow-sm"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
              }`}
            >
              Manual
            </button>
          </div>
        </div>

        <div className="bg-primary/5 rounded-lg p-3 border border-primary/20">
          <div className="flex items-center gap-2 mb-2">
            <Sparkles size={14} className="text-primary" />
            <span className="text-xs font-medium text-foreground">AI Status</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></span>
            <span className="text-xs text-muted-foreground">Ready for commands</span>
          </div>
        </div>
        {user && (
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                <User size={12} className="text-primary" />
              </div>
              <span className="text-xs text-muted-foreground truncate">{user.email || user.name || "User"}</span>
            </div>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground hover:text-red-500" onClick={handleLogout} title="Logout">
              <LogOut size={13} />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
};

export default function Layout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const navigate = useNavigate();

  // Load notifications for the first site
  useEffect(() => {
    const loadNotifs = async () => {
      try {
        const { getSites } = await import("../lib/api");
        const r = await getSites();
        const sites = r.data || [];
        if (sites.length) {
          const { getNotifications } = await import("../lib/api");
          const nr = await getNotifications(sites[0].id);
          setNotifications(Array.isArray(nr.data) ? nr.data : []);
        }
      } catch { }
    };
    loadNotifs();
  }, []);

  // CMD+K keyboard shortcut
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setCmdOpen(prev => !prev);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const handleNavFromCmd = useCallback((path) => {
    navigate(path);
    setCmdOpen(false);
  }, [navigate]);

  return (
    <div className="min-h-screen bg-background">
      {/* Desktop Sidebar */}
      <aside className="hidden md:flex fixed inset-y-0 left-0 w-64 border-r border-border/30 bg-card/50 backdrop-blur-xl z-50">
        <Sidebar notifications={notifications} onOpenSearch={() => setCmdOpen(true)} />
      </aside>

      {/* Mobile Header */}
      <header className="md:hidden fixed top-0 left-0 right-0 h-16 border-b border-border/30 bg-card/80 backdrop-blur-xl z-50 flex items-center px-4">
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" data-testid="mobile-menu-btn">
              <MenuIcon size={20} />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-64 p-0 bg-card border-r border-border/30">
            <Sidebar onNavClick={() => setMobileOpen(false)} notifications={notifications} onOpenSearch={() => { setMobileOpen(false); setCmdOpen(true); }} />
          </SheetContent>
        </Sheet>
        
        <div className="flex items-center gap-2 ml-3 flex-1">
          <Zap size={20} className="text-primary" />
          <span className="font-heading font-bold">WP Autopilot</span>
          {localStorage.getItem("apply_mode") === "manual" && (
            <span className="text-[10px] font-semibold bg-yellow-500/15 text-yellow-600 border border-yellow-500/30 rounded px-1.5 py-0.5 ml-1">
              Manual Mode
            </span>
          )}
        </div>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setCmdOpen(true)}>
          <Search size={16} />
        </Button>
      </header>

      {/* Main Content */}
      <main className="md:ml-64 min-h-screen">
        <div className="pt-16 md:pt-0">
          <AnimatePresence mode="wait">
            <motion.div
              key={location.pathname}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2 }}
            >
              <Outlet />
            </motion.div>
          </AnimatePresence>
        </div>
      </main>

      {/* CMD+K Global Search */}
      <CommandDialog open={cmdOpen} onOpenChange={setCmdOpen}>
        <CommandInput placeholder="Search pages, features..." />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>
          {navGroups.map((group, gi) => (
            <CommandGroup key={gi} heading={group.label || "General"}>
              {group.items.map(item => (
                <CommandItem key={item.path} onSelect={() => handleNavFromCmd(item.path)}
                  className="flex items-center gap-2 cursor-pointer">
                  <item.icon size={14} className="text-muted-foreground" />
                  {item.label}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
      </CommandDialog>
    </div>
  );
}
