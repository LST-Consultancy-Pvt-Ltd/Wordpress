import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import {
  Menu as MenuIcon,
  RefreshCw,
  Loader2,
  AlertCircle,
  ChevronRight,
  ExternalLink,
  Info
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { ScrollArea } from "../components/ui/scroll-area";
import { getSites, getNavigation, syncNavigation } from "../lib/api";
import { toast } from "sonner";

export default function Navigation() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [menus, setMenus] = useState([]);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    loadSites();
  }, []);

  useEffect(() => {
    if (selectedSite) {
      loadMenus();
    }
  }, [selectedSite]);

  const loadSites = async () => {
    try {
      const response = await getSites();
      setSites(response.data);
      if (response.data.length > 0) {
        setSelectedSite(response.data[0].id);
      }
    } catch (error) {
      toast.error("Failed to load sites");
    }
  };

  const loadMenus = async () => {
    setLoading(true);
    try {
      const response = await getNavigation(selectedSite);
      setMenus(response.data);
    } catch (error) {
      console.error("Failed to load menus");
    } finally {
      setLoading(false);
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      await syncNavigation(selectedSite);
      await loadMenus();
      toast.success("Navigation synced");
    } catch (error) {
      toast.error("Failed to sync navigation");
    } finally {
      setSyncing(false);
    }
  };

  const selectedSiteData = sites.find(s => s.id === selectedSite);

  return (
    <div className="page-container" data-testid="navigation-page">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <motion.h1
            className="page-title"
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
          >
            Navigation Manager
          </motion.h1>
          <motion.p
            className="page-description"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.1 }}
          >
            Manage your WordPress navigation menus
          </motion.p>
        </div>

        <div className="flex items-center gap-3">
          <Select value={selectedSite} onValueChange={setSelectedSite}>
            <SelectTrigger className="w-[200px]" data-testid="site-select">
              <SelectValue placeholder="Select a site" />
            </SelectTrigger>
            <SelectContent>
              {sites.map((site) => (
                <SelectItem key={site.id} value={site.id}>
                  {site.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            variant="outline"
            onClick={handleSync}
            disabled={!selectedSite || syncing}
            data-testid="sync-nav-btn"
          >
            {syncing ? (
              <Loader2 size={16} className="mr-2 animate-spin" />
            ) : (
              <RefreshCw size={16} className="mr-2" />
            )}
            Sync Menus
          </Button>
        </div>
      </div>

      {!selectedSite ? (
        <Card className="content-card">
          <CardContent className="flex flex-col items-center justify-center py-16">
            <AlertCircle size={48} className="text-muted-foreground/30 mb-4" />
            <p className="text-muted-foreground">Please select a site to view navigation</p>
          </CardContent>
        </Card>
      ) : loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 size={32} className="animate-spin text-primary" />
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Info Card */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="lg:col-span-2"
          >
            <Card className="content-card bg-primary/5 border-primary/20">
              <CardContent className="p-6">
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                    <Info size={20} className="text-primary" />
                  </div>
                  <div>
                    <h3 className="font-heading font-medium mb-2">WordPress Menu API</h3>
                    <p className="text-sm text-muted-foreground mb-3">
                      The WordPress REST API requires the WP-REST-API-V2-Menus plugin to expose menu endpoints. 
                      If menus aren't syncing, install the plugin on your WordPress site.
                    </p>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" asChild>
                        <a 
                          href="https://wordpress.org/plugins/wp-rest-api-v2-menus/" 
                          target="_blank" 
                          rel="noopener noreferrer"
                        >
                          Get Plugin <ExternalLink size={12} className="ml-1" />
                        </a>
                      </Button>
                      {selectedSiteData && (
                        <Button variant="outline" size="sm" asChild>
                          <a 
                            href={`${selectedSiteData.url}/wp-admin/nav-menus.php`}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            WP Menu Editor <ExternalLink size={12} className="ml-1" />
                          </a>
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>

          {/* Menus List */}
          {menus.length > 0 ? (
            menus.map((menu, index) => (
              <motion.div
                key={menu.id || index}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.1 }}
              >
                <Card className="content-card h-full">
                  <CardHeader>
                    <CardTitle className="text-lg font-heading flex items-center justify-between">
                      <span className="flex items-center gap-2">
                        <MenuIcon size={18} className="text-primary" />
                        {menu.name || `Menu ${menu.wp_menu_id}`}
                      </span>
                      <Badge variant="outline">ID: {menu.wp_menu_id}</Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ScrollArea className="h-[200px]">
                      {menu.items && menu.items.length > 0 ? (
                        <ul className="space-y-2">
                          {menu.items.map((item, i) => (
                            <li 
                              key={i}
                              className="flex items-center gap-2 p-2 rounded-lg hover:bg-muted/30 transition-colors"
                            >
                              <ChevronRight size={14} className="text-muted-foreground" />
                              <span className="text-sm">{item.title || item.name || `Item ${i + 1}`}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-sm text-muted-foreground text-center py-8">
                          No menu items synced
                        </p>
                      )}
                    </ScrollArea>
                    <p className="text-xs text-muted-foreground mt-4">
                      Last synced: {menu.synced_at ? new Date(menu.synced_at).toLocaleString() : "Never"}
                    </p>
                  </CardContent>
                </Card>
              </motion.div>
            ))
          ) : (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="lg:col-span-2"
            >
              <Card className="content-card">
                <CardContent className="flex flex-col items-center justify-center py-16">
                  <MenuIcon size={48} className="text-muted-foreground/30 mb-4" />
                  <h3 className="font-heading font-medium mb-1">No menus found</h3>
                  <p className="text-muted-foreground text-sm text-center max-w-md">
                    Click "Sync Menus" to fetch menus from your WordPress site.
                    Make sure the WP-REST-API-V2-Menus plugin is installed.
                  </p>
                </CardContent>
              </Card>
            </motion.div>
          )}

          {/* AI Menu Management */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="lg:col-span-2"
          >
            <Card className="content-card">
              <CardHeader>
                <CardTitle className="text-lg font-heading">AI Menu Management</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground mb-4">
                  Use the AI Command Center to manage navigation with natural language:
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="p-4 rounded-lg border border-border/50 bg-muted/20">
                    <p className="text-sm font-medium mb-1">"Add homepage to main menu"</p>
                    <p className="text-xs text-muted-foreground">Creates new menu item linking to homepage</p>
                  </div>
                  <div className="p-4 rounded-lg border border-border/50 bg-muted/20">
                    <p className="text-sm font-medium mb-1">"Update navigation structure"</p>
                    <p className="text-xs text-muted-foreground">AI suggests optimal menu organization</p>
                  </div>
                  <div className="p-4 rounded-lg border border-border/50 bg-muted/20">
                    <p className="text-sm font-medium mb-1">"Add all service pages to footer"</p>
                    <p className="text-xs text-muted-foreground">Batch add pages to footer menu</p>
                  </div>
                  <div className="p-4 rounded-lg border border-border/50 bg-muted/20">
                    <p className="text-sm font-medium mb-1">"Optimize menu for mobile"</p>
                    <p className="text-xs text-muted-foreground">Get mobile navigation recommendations</p>
                  </div>
                </div>
                <Button variant="outline" className="mt-4" asChild>
                  <a href="/ai-command">Go to AI Command Center</a>
                </Button>
              </CardContent>
            </Card>
          </motion.div>
        </div>
      )}
    </div>
  );
}
