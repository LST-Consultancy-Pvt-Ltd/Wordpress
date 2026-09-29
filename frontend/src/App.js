import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "./components/ui/sonner";
import Layout from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import SitesList from "./pages/sites/SitesList";
import SiteWizard from "./pages/sites/SiteWizard";
import SiteDetail from "./pages/sites/SiteDetail";
import SiteInventory from "./pages/sites/SiteInventory";
import SiteContent from "./pages/sites/SiteContent";
import SiteCode from "./pages/sites/SiteCode";
import SiteOperations from "./pages/sites/SiteOperations";
import SiteBackups from "./pages/sites/SiteBackups";
import ChangeSetList from "./pages/changesets/ChangeSetList";
import ChangeSetDetail from "./pages/changesets/ChangeSetDetail";
import Audit from "./pages/Audit";
import RequireRole from "./components/RequireRole";
import { dropStaleSessionKeys, getToken } from "./lib/session";
import AICommand from "./pages/AICommand";
import SEO from "./pages/SEO";
import OnPageSEO from "./pages/OnPageSEO";
import ContentRefresh from "./pages/ContentRefresh";
import Settings from "./pages/Settings";
import Activity from "./pages/Activity";
import BrokenLinks from "./pages/BrokenLinks";
import DuplicateContent from "./pages/DuplicateContent";
import Login from "./pages/Login";
import Register from "./pages/Register";
import KeywordTracking from "./pages/KeywordTracking";
import SiteSpeed from "./pages/SiteSpeed";
import LinkBuilder from "./pages/LinkBuilder";
import Reports from "./pages/Reports";
import LocalTracking from "./pages/LocalTracking";
import ReportBuilder from "./pages/ReportBuilder";
import CrawlReport from "./pages/CrawlReport";
import Autopilot from "./pages/Autopilot";
import SocialMedia from "./pages/SocialMedia";
import SiteHealth from "./pages/SiteHealth";
import KeywordClusters from "./pages/KeywordClusters";
import AIContentDetector from "./pages/AIContentDetector";
import KeywordResearch from "./pages/KeywordResearch";
import AutoBlogGeneration from "./pages/AutoBlogGeneration";
import KeywordAnalysis from "./pages/KeywordAnalysis";

import SitemapRobots from "./pages/SitemapRobots";
import MobileChecker from "./pages/MobileChecker";

import BacklinkOutreach from "./pages/BacklinkOutreach";
import GuestPosting from "./pages/GuestPosting";
import IndexingTracker from "./pages/IndexingTracker";
import LinkReclamation from "./pages/LinkReclamation";
import LocalCitations from "./pages/LocalCitations";
import Newsletter from "./pages/Newsletter";
import OffPageAutopilot from "./pages/OffPageAutopilot";
import ProgrammaticSEO from "./pages/ProgrammaticSEO";
import LandingPage from "./pages/LandingPage";
import AdsManager from "./pages/AdsManager";
import MediaPlanAutomation from "./pages/MediaPlanAutomation";
import PlatformPortfolio from "./pages/PlatformPortfolio";
import CompanyProfile from "./pages/CompanyProfile";
import OutreachApprovals from "./pages/OutreachApprovals";
import "./App.css";

// Sessions stored by older builds under other key names are discarded; users sign in again.
dropStaleSessionKeys();

export function AuthGuard({ children }) {
  if (!getToken()) return <Navigate to="/login" replace />;
  return children;
}

function App() {
  return (
    <div className="dark">
      <BrowserRouter>
        <Routes>
          <Route path="/landing" element={<LandingPage />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/" element={<AuthGuard><Layout /></AuthGuard>}>
            <Route index element={<Dashboard />} />
            <Route path="sites" element={<SitesList />} />
            <Route path="sites/new" element={<RequireRole min="admin" page><SiteWizard /></RequireRole>} />
            <Route path="sites/:id" element={<SiteDetail />} />
            <Route path="sites/:id/inventory" element={<SiteInventory />} />
            <Route path="sites/:id/content" element={<SiteContent />} />
            <Route path="sites/:id/code" element={<SiteCode />} />
            <Route path="sites/:id/operations" element={<SiteOperations />} />
            <Route path="sites/:id/backups" element={<SiteBackups />} />
            <Route path="changesets" element={<ChangeSetList />} />
            <Route path="changesets/:id" element={<ChangeSetDetail />} />
            <Route path="audit" element={<Audit />} />
            <Route path="ai-command" element={<AICommand />} />
            <Route path="seo" element={<SEO />} />
            <Route path="onpage-seo" element={<OnPageSEO />} />
            <Route path="content-refresh" element={<ContentRefresh />} />
            <Route path="broken-links" element={<BrokenLinks />} />
            <Route path="duplicate-content" element={<DuplicateContent />} />
            <Route path="settings" element={<Settings />} />
            <Route path="activity" element={<Activity />} />
            <Route path="keyword-tracking" element={<KeywordTracking />} />
            <Route path="site-speed" element={<SiteSpeed />} />
            <Route path="link-builder" element={<LinkBuilder />} />
            <Route path="reports" element={<Reports />} />
            <Route path="local-tracking" element={<LocalTracking />} />
            <Route path="report-builder" element={<ReportBuilder />} />
            <Route path="crawl-report" element={<CrawlReport />} />
            <Route path="autopilot" element={<Autopilot />} />
            <Route path="social-media" element={<SocialMedia />} />
            <Route path="site-health" element={<SiteHealth />} />
            <Route path="keyword-clusters" element={<KeywordClusters />} />
            <Route path="ai-content-detector" element={<AIContentDetector />} />
            <Route path="keyword-research" element={<KeywordResearch />} />
            <Route path="auto-blog-generation" element={<AutoBlogGeneration />} />
            <Route path="keyword-analysis" element={<KeywordAnalysis />} />
            <Route path="sitemap-robots" element={<SitemapRobots />} />
            <Route path="mobile-checker" element={<MobileChecker />} />

            <Route path="backlink-outreach" element={<BacklinkOutreach />} />

            <Route path="guest-posting" element={<GuestPosting />} />
            <Route path="indexing-tracker" element={<IndexingTracker />} />
            <Route path="link-reclamation" element={<LinkReclamation />} />
            <Route path="local-citations" element={<LocalCitations />} />
            <Route path="newsletter" element={<Newsletter />} />
            <Route path="offpage-autopilot" element={<OffPageAutopilot />} />
            <Route path="programmatic-seo" element={<ProgrammaticSEO />} />
            <Route path="ads-manager" element={<AdsManager />} />
            <Route path="media-plan" element={<MediaPlanAutomation />} />
            <Route path="portfolio" element={<PlatformPortfolio />} />
            <Route path="company-profile" element={<CompanyProfile />} />
            <Route path="outreach-approvals" element={<OutreachApprovals />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
      <Toaster position="top-right" richColors />
    </div>
  );
}

export default App;
