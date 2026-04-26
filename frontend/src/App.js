import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "./components/ui/sonner";
import Layout from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import Sites from "./pages/Sites";
import AICommand from "./pages/AICommand";
import Pages from "./pages/Pages";
import Posts from "./pages/Posts";
import SEO from "./pages/SEO";
import ContentRefresh from "./pages/ContentRefresh";
import Settings from "./pages/Settings";
import Activity from "./pages/Activity";
import BrokenLinks from "./pages/BrokenLinks";
import DuplicateContent from "./pages/DuplicateContent";
import Calendar from "./pages/Calendar";
import Login from "./pages/Login";
import Register from "./pages/Register";
import SearchVisibility from "./pages/SearchVisibility";
import KeywordTracking from "./pages/KeywordTracking";
import SiteSpeed from "./pages/SiteSpeed";
import LinkBuilder from "./pages/LinkBuilder";
import Reports from "./pages/Reports";
import LocalTracking from "./pages/LocalTracking";
import LiveEditor from "./pages/LiveEditor";
import ReportBuilder from "./pages/ReportBuilder";
import CrawlReport from "./pages/CrawlReport";
import Autopilot from "./pages/Autopilot";
import MediaLibrary from "./pages/MediaLibrary";
import Comments from "./pages/Comments";
import WPUsers from "./pages/WPUsers";
import PluginsThemes from "./pages/PluginsThemes";
import Backups from "./pages/Backups";
import Redirects from "./pages/Redirects";
import ABTesting from "./pages/ABTesting";
import SocialMedia from "./pages/SocialMedia";
import SiteHealth from "./pages/SiteHealth";
import KeywordClusters from "./pages/KeywordClusters";
import AIContentDetector from "./pages/AIContentDetector";
import KeywordResearch from "./pages/KeywordResearch";
import AutoBlogGeneration from "./pages/AutoBlogGeneration";
import KeywordAnalysis from "./pages/KeywordAnalysis";

import SchemaMarkup from "./pages/SchemaMarkup";
import SitemapRobots from "./pages/SitemapRobots";
import CanonicalManager from "./pages/CanonicalManager";
import MobileChecker from "./pages/MobileChecker";

import BacklinkOutreach from "./pages/BacklinkOutreach";
import BrandMentions from "./pages/BrandMentions";
import GBPOptimizer from "./pages/GBPOptimizer";
import GuestPosting from "./pages/GuestPosting";
import IndexingTracker from "./pages/IndexingTracker";
import LinkReclamation from "./pages/LinkReclamation";
import LocalCitations from "./pages/LocalCitations";
import RevenueDashboard from "./pages/RevenueDashboard";
import ReviewGrowth from "./pages/ReviewGrowth";
import CommunityEngagement from "./pages/CommunityEngagement";
import DigitalPR from "./pages/DigitalPR";
import Forms from "./pages/Forms";
import InfluencerOutreach from "./pages/InfluencerOutreach";
import Navigation from "./pages/Navigation";
import Newsletter from "./pages/Newsletter";
import OffPageAutopilot from "./pages/OffPageAutopilot";
import PodcastOutreach from "./pages/PodcastOutreach";
import ProgrammaticSEO from "./pages/ProgrammaticSEO";
import WooCommerce from "./pages/WooCommerce";
import LandingPage from "./pages/LandingPage";
import "./App.css";

function AuthGuard({ children }) {
  const token = localStorage.getItem("wp_token");
  if (!token) return <Navigate to="/login" replace />;
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
            <Route path="sites" element={<Sites />} />
            <Route path="ai-command" element={<AICommand />} />
            <Route path="pages" element={<Pages />} />
            <Route path="posts" element={<Posts />} />
            <Route path="seo" element={<SEO />} />
            <Route path="content-refresh" element={<ContentRefresh />} />
            <Route path="broken-links" element={<BrokenLinks />} />
            <Route path="duplicate-content" element={<DuplicateContent />} />
            <Route path="calendar" element={<Calendar />} />
            <Route path="settings" element={<Settings />} />
            <Route path="activity" element={<Activity />} />
            <Route path="search-visibility" element={<SearchVisibility />} />
            <Route path="keyword-tracking" element={<KeywordTracking />} />
            <Route path="site-speed" element={<SiteSpeed />} />
            <Route path="link-builder" element={<LinkBuilder />} />
            <Route path="reports" element={<Reports />} />
            <Route path="local-tracking" element={<LocalTracking />} />
            <Route path="live-editor" element={<LiveEditor />} />
            <Route path="report-builder" element={<ReportBuilder />} />
            <Route path="crawl-report" element={<CrawlReport />} />
            <Route path="autopilot" element={<Autopilot />} />
            <Route path="media-library" element={<MediaLibrary />} />
            <Route path="comments" element={<Comments />} />
            <Route path="wp-users" element={<WPUsers />} />
            <Route path="plugins-themes" element={<PluginsThemes />} />
            <Route path="backups" element={<Backups />} />
            <Route path="redirects" element={<Redirects />} />
            <Route path="ab-testing" element={<ABTesting />} />
            <Route path="social-media" element={<SocialMedia />} />
            <Route path="site-health" element={<SiteHealth />} />
            <Route path="keyword-clusters" element={<KeywordClusters />} />
            <Route path="ai-content-detector" element={<AIContentDetector />} />
            <Route path="keyword-research" element={<KeywordResearch />} />
            <Route path="auto-blog-generation" element={<AutoBlogGeneration />} />
            <Route path="keyword-analysis" element={<KeywordAnalysis />} />

            <Route path="schema-markup" element={<SchemaMarkup />} />
            <Route path="sitemap-robots" element={<SitemapRobots />} />
            <Route path="canonical-manager" element={<CanonicalManager />} />
            <Route path="mobile-checker" element={<MobileChecker />} />

            <Route path="backlink-outreach" element={<BacklinkOutreach />} />
            <Route path="brand-mentions" element={<BrandMentions />} />

            <Route path="gbp-optimizer" element={<GBPOptimizer />} />
            <Route path="guest-posting" element={<GuestPosting />} />
            <Route path="indexing-tracker" element={<IndexingTracker />} />
            <Route path="link-reclamation" element={<LinkReclamation />} />
            <Route path="local-citations" element={<LocalCitations />} />
            <Route path="revenue-dashboard" element={<RevenueDashboard />} />
            <Route path="review-growth" element={<ReviewGrowth />} />
            <Route path="community-engagement" element={<CommunityEngagement />} />
            <Route path="digital-pr" element={<DigitalPR />} />
            <Route path="forms" element={<Forms />} />
            <Route path="influencer-outreach" element={<InfluencerOutreach />} />
            <Route path="navigation" element={<Navigation />} />
            <Route path="newsletter" element={<Newsletter />} />
            <Route path="offpage-autopilot" element={<OffPageAutopilot />} />
            <Route path="podcast-outreach" element={<PodcastOutreach />} />
            <Route path="programmatic-seo" element={<ProgrammaticSEO />} />
            <Route path="woocommerce" element={<WooCommerce />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
      <Toaster position="top-right" richColors />
    </div>
  );
}

export default App;
