import { useState, useEffect, useCallback } from "react";
import { useOutlet, NavLink, useLocation, useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  LayoutDashboard,
  Globe,
  Sparkles,
  Search,
  Menu as MenuIcon,
  RefreshCw,
  Settings,
  Activity,
  Link2,
  Copy,
  ChevronRight,
  Zap,
  LogOut,
  User,
  Target,
  Gauge,
  Network,
  BarChart3,
  MapPin,
  LayoutGrid,
  Bug,
  Bot,
  Share2,
  HeartPulse,
  Bell,
  Hash,
  PenLine,
  Map,
  Smartphone,
  ShieldCheck,
  LinkIcon,
  ExternalLink,
  Bookmark,
  Compass,
  Mail,
  Layers,
  BarChart2,
  FileSpreadsheet,
  Building2,
  ClipboardCheck,
  GitPullRequest,
  ScrollText,
  PlusCircle,
} from "lucide-react";
import { Button } from "./ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "./ui/sheet";
import { ScrollArea } from "./ui/scroll-area";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./ui/command";
import { getNotifications, getSites } from "../lib/api";
import { clearSession } from "../lib/session";
import { useRole } from "../hooks/useRole";
import { ROLE_LABELS } from "../lib/roles";

export const navGroups = [
  {
    label: null,
    items: [
      { path: "/", icon: LayoutDashboard, label: "Dashboard" },
      { path: "/portfolio", icon: LayoutGrid, label: "Portfolio" },
      { path: "/ai-command", icon: Sparkles, label: "AI Command" },
      { path: "/autopilot", icon: Bot, label: "Autopilot" },
    ],
  },
  {
    label: "Sites & Delivery",
    items: [
      { path: "/sites", icon: Globe, label: "Sites" },
      { path: "/sites/new", icon: PlusCircle, label: "Connect a Site", minRole: "admin" },
      { path: "/changesets", icon: GitPullRequest, label: "Change Sets" },
      { path: "/audit", icon: ScrollText, label: "Audit" },
    ],
  },
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
  {
    label: "SEO & Analytics",
    items: [
      { path: "/seo", icon: Search, label: "SEO Metrics" },
      { path: "/onpage-seo", icon: Gauge, label: "On-Page SEO" },
      { path: "/keyword-tracking", icon: Target, label: "Keyword Tracking" },
      { path: "/keyword-clusters", icon: Hash, label: "Keyword Clusters" },
      { path: "/site-speed", icon: Gauge, label: "Site Speed" },
      { path: "/link-builder", icon: Network, label: "Link Builder" },
      { path: "/broken-links", icon: Link2, label: "Broken Links" },
      { path: "/duplicate-content", icon: Copy, label: "Duplicate Content" },
      { path: "/content-refresh", icon: RefreshCw, label: "Content Refresh" },
      { path: "/crawl-report", icon: Bug, label: "Crawl Report" },
      { path: "/sitemap-robots", icon: Map, label: "Sitemap & Robots" },
      { path: "/mobile-checker", icon: Smartphone, label: "Mobile Checker" },
      { path: "/indexing-tracker", icon: Compass, label: "Indexing Tracker" },
      { path: "/reports", icon: BarChart3, label: "Reports" },
      { path: "/report-builder", icon: LayoutGrid, label: "Report Builder" },
    ],
  },
  {
    label: "Off-Page SEO",
    items: [
      { path: "/backlink-outreach", icon: ExternalLink, label: "Backlink Outreach" },
      { path: "/guest-posting", icon: PenLine, label: "Guest Posting" },
      { path: "/link-reclamation", icon: LinkIcon, label: "Link Reclamation" },
      { path: "/offpage-autopilot", icon: Zap, label: "Off-Page Autopilot" },
      { path: "/outreach-approvals", icon: ClipboardCheck, label: "Outreach Approvals" },
    ],
  },
  {
    label: "Local SEO",
    items: [
      { path: "/local-tracking", icon: MapPin, label: "Local Tracking" },
      { path: "/local-citations", icon: Bookmark, label: "Local Citations" },
      { path: "/company-profile", icon: Building2, label: "Company Profile" },
    ],
  },
  {
    label: "Health & Uptime",
    items: [
      { path: "/site-health", icon: HeartPulse, label: "Site Health" },
      { path: "/activity", icon: Activity, label: "Activity" },
    ],
  },
  {
    label: "Marketing",
    items: [
      { path: "/social-media", icon: Share2, label: "Social Media" },
      { path: "/newsletter", icon: Mail, label: "Newsletter" },
    ],
  },
  {
    label: "Paid Ads",
    items: [{ path: "/ads-manager", icon: BarChart2, label: "Ads Manager" }],
  },
  {
    label: "Automation Hub",
    items: [{ path: "/media-plan", icon: FileSpreadsheet, label: "Media Plan Automation" }],
  },
  {
    label: null,
    items: [{ path: "/settings", icon: Settings, label: "Settings" }],
  },
];

const testIdFor = (label) => `nav-${label.toLowerCase().replace(/&/g, "and").replace(/\s+/g, "-")}`;

function isActivePath(pathname, path) {
  if (path === "/") return pathname === "/";
  if (path === "/sites") return pathname === "/sites" || (pathname.startsWith("/sites/") && pathname !== "/sites/new");
  return pathname === path || pathname.startsWith(`${path}/`);
}

const NavItem = ({ item, isActive, onClick }) => (
  <NavLink
    to={item.path}
    end
    onClick={onClick}
    className={`flex items-center gap-3 px-4 py-2.5 rounded-md text-sm font-medium transition-all duration-200 ${
      isActive ? "bg-primary/10 text-primary ai-glow" : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
    }`}
    aria-current={isActive ? "page" : undefined}
    data-testid={testIdFor(item.label)}
  >
    <item.icon size={18} strokeWidth={1.5} aria-hidden="true" />
    <span>{item.label}</span>
    {isActive && <ChevronRight size={14} className="ml-auto text-primary" aria-hidden="true" />}
  </NavLink>
);

const Sidebar = ({ className = "", onNavClick, notifications = [], onOpenSearch }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, role, can } = useRole();
  const unread = notifications.filter((n) => !n.read).length;

  const handleLogout = () => {
    clearSession();
    navigate("/login");
  };

  return (
    <div className={`flex flex-col h-full ${className}`}>
      <div className="p-6 border-b border-border/30">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center ai-pulse">
            <Zap size={22} className="text-primary" aria-hidden="true" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-heading font-bold text-lg text-foreground" data-testid="brand-name">Site Autopilot</p>
            <p className="text-xs text-muted-foreground">Next.js automation platform</p>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" className="relative h-8 w-8" onClick={onOpenSearch} aria-label="Search (Cmd+K)">
              <Search size={15} className="text-muted-foreground" aria-hidden="true" />
            </Button>
            <Button variant="ghost" size="icon" className="relative h-8 w-8" aria-label={`Notifications${unread ? ` (${unread} unread)` : ""}`}>
              <Bell size={15} className="text-muted-foreground" aria-hidden="true" />
              {unread > 0 && (
                <span className="absolute -top-0.5 -right-0.5 h-4 w-4 rounded-full bg-primary text-[9px] flex items-center justify-center text-primary-foreground font-bold" aria-hidden="true">
                  {unread > 9 ? "9+" : unread}
                </span>
              )}
            </Button>
          </div>
        </div>
      </div>

      <ScrollArea className="flex-1 px-3 py-4">
        <nav className="space-y-0.5" aria-label="Main">
          {navGroups.map((group, gi) => {
            const items = group.items.filter((it) => can(it.minRole));
            if (!items.length) return null;
            return (
              <div key={gi} className={gi > 0 ? "mt-4" : ""}>
                {group.label && (
                  <p className="px-4 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-1">{group.label}</p>
                )}
                {items.map((item) => (
                  <NavItem key={item.path} item={item} isActive={isActivePath(location.pathname, item.path)} onClick={onNavClick} />
                ))}
              </div>
            );
          })}
        </nav>
      </ScrollArea>

      <div className="p-4 border-t border-border/30 space-y-3">
        <div className="bg-primary/5 rounded-lg p-3 border border-primary/20 text-xs text-muted-foreground">
          Changes to sites are proposed as change sets and applied only after approval.
        </div>
        {user && (
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                <User size={12} className="text-primary" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground truncate">{user.email || user.name || "User"}</p>
                <p className="text-[10px] text-muted-foreground/70" data-testid="current-role">{ROLE_LABELS[role] || role}</p>
              </div>
            </div>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground hover:text-red-500" onClick={handleLogout} aria-label="Log out">
              <LogOut size={13} aria-hidden="true" />
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
  const location = useLocation();
  // Capture the routed element so the exiting page keeps rendering its own
  // route during the transition (an <Outlet/> there would render the new
  // route too, mounting the next page twice).
  const outlet = useOutlet();
  const { can } = useRole();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await getSites();
        const sites = Array.isArray(r.data) ? r.data : r.data?.items || [];
        if (sites.length) {
          const nr = await getNotifications(sites[0].id);
          if (!cancelled) setNotifications(Array.isArray(nr.data) ? nr.data : []);
        }
      } catch {
        /* notifications are optional */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setCmdOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const handleNavFromCmd = useCallback(
    (path) => {
      navigate(path);
      setCmdOpen(false);
    },
    [navigate]
  );

  return (
    <div className="min-h-screen bg-background">
      <aside className="hidden md:flex fixed inset-y-0 left-0 w-64 border-r border-border/30 bg-card/50 backdrop-blur-xl z-50">
        <Sidebar notifications={notifications} onOpenSearch={() => setCmdOpen(true)} />
      </aside>

      <header className="md:hidden fixed top-0 left-0 right-0 h-16 border-b border-border/30 bg-card/80 backdrop-blur-xl z-50 flex items-center px-4">
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" data-testid="mobile-menu-btn" aria-label="Open navigation">
              <MenuIcon size={20} aria-hidden="true" />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-64 p-0 bg-card border-r border-border/30">
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <Sidebar
              onNavClick={() => setMobileOpen(false)}
              notifications={notifications}
              onOpenSearch={() => {
                setMobileOpen(false);
                setCmdOpen(true);
              }}
            />
          </SheetContent>
        </Sheet>
        <div className="flex items-center gap-2 ml-3 flex-1">
          <Zap size={20} className="text-primary" aria-hidden="true" />
          <span className="font-heading font-bold">Site Autopilot</span>
        </div>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setCmdOpen(true)} aria-label="Search">
          <Search size={16} aria-hidden="true" />
        </Button>
      </header>

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
              {outlet}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>

      <CommandDialog open={cmdOpen} onOpenChange={setCmdOpen}>
        <CommandInput placeholder="Search pages, features..." />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>
          {navGroups.map((group, gi) => (
            <CommandGroup key={gi} heading={group.label || "General"}>
              {group.items
                .filter((it) => can(it.minRole))
                .map((item) => (
                  <CommandItem key={item.path} onSelect={() => handleNavFromCmd(item.path)} className="flex items-center gap-2 cursor-pointer">
                    <item.icon size={14} className="text-muted-foreground" aria-hidden="true" />
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
