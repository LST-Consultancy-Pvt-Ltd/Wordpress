import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { ShoppingCart, Package, Users, TrendingUp, Loader2, Bot, RefreshCw, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "../components/ui/select";
import { ScrollArea } from "../components/ui/scroll-area";
import SSEProgressDrawer, { useSSETask } from "../components/SSEProgressDrawer";
import {
  getSites, getWooProducts, getWooOrders, getWooCustomers, getWooStats,
  wooAIDescription, wooBulkAIDescriptions, wooLowStockAlert,
} from "../lib/api";
import { toast } from "sonner";

const STATUS_COLORS = {
  publish: "border-emerald-500/30 text-emerald-500",
  draft: "border-gray-500/30 text-gray-400",
  pending: "border-yellow-500/30 text-yellow-500",
  private: "border-blue-500/30 text-blue-500",
  processing: "border-blue-500/30 text-blue-500",
  completed: "border-emerald-500/30 text-emerald-500",
  cancelled: "border-red-500/30 text-red-500",
  refunded: "border-orange-500/30 text-orange-400",
  "on-hold": "border-yellow-500/30 text-yellow-500",
};

export default function WooCommerce() {
  const [sites, setSites] = useState([]);
  const [selectedSite, setSelectedSite] = useState("");
  const [stats, setStats] = useState(null);
  const [products, setProducts] = useState([]);
  const [orders, setOrders] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [lowStock, setLowStock] = useState([]);
  const [loading, setLoading] = useState({});
  const [rewritingId, setRewritingId] = useState(null);
  const [activeTab, setActiveTab] = useState("products");
  const { tasks, startTask, dismissTask } = useSSETask();

  useEffect(() => { loadSites(); }, []);
  useEffect(() => {
    if (selectedSite) { loadStats(); loadProducts(); loadOrders(); loadCustomers(); loadLowStock(); }
  }, [selectedSite]);

  const loadSites = async () => {
    try {
      const r = await getSites();
      setSites(r.data || []);
      if (r.data?.length) setSelectedSite(r.data[0].id);
    } catch { }
  };

  const setLoad = (key, val) => setLoading(prev => ({ ...prev, [key]: val }));

  const loadStats = async () => {
    setLoad("stats", true);
    try {
      const r = await getWooStats(selectedSite);
      setStats(r.data);
    } catch { } finally { setLoad("stats", false); }
  };

  const loadProducts = async () => {
    setLoad("products", true);
    try {
      const r = await getWooProducts(selectedSite);
      setProducts(Array.isArray(r.data) ? r.data : []);
    } catch (err) { toast.error(err.response?.data?.detail || "Failed to load products"); }
    finally { setLoad("products", false); }
  };

  const loadOrders = async () => {
    setLoad("orders", true);
    try {
      const r = await getWooOrders(selectedSite);
      setOrders(Array.isArray(r.data) ? r.data : []);
    } catch { } finally { setLoad("orders", false); }
  };

  const loadCustomers = async () => {
    setLoad("customers", true);
    try {
      const r = await getWooCustomers(selectedSite);
      setCustomers(Array.isArray(r.data) ? r.data : []);
    } catch { } finally { setLoad("customers", false); }
  };

  const loadLowStock = async () => {
    try {
      const r = await wooLowStockAlert(selectedSite);
      setLowStock(Array.isArray(r.data) ? r.data : (r.data?.products || []));
    } catch { }
  };

  const handleRewriteDescription = async (productId) => {
    setRewritingId(productId);
    try {
      const r = await wooAIDescription(selectedSite, productId);
      setProducts(prev => prev.map(p => p.id === productId ? { ...p, description: r.data.description } : p));
      toast.success("Description rewritten by AI");
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to rewrite description");
    } finally { setRewritingId(null); }
  };

  const handleBulkDescriptions = async () => {
    try {
      const r = await wooBulkAIDescriptions(selectedSite);
      startTask(r.data.task_id, "AI: Rewriting all product descriptions");
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to start bulk rewrite");
    }
  };

  const statCards = [
    { label: "Total Revenue", value: stats ? `$${Number(stats.revenue || 0).toLocaleString()}` : "—", icon: TrendingUp },
    { label: "Total Orders", value: stats?.total_orders ?? products.length ?? "—", icon: ShoppingCart },
    { label: "Products", value: stats?.total_products ?? products.length ?? "—", icon: Package },
    { label: "Customers", value: stats?.total_customers ?? customers.length ?? "—", icon: Users },
  ];

  return (
    <div className="page-container">
      <div className="mb-8">
        <motion.h1 className="page-title" initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
          WooCommerce
        </motion.h1>
        <motion.p className="page-description" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }}>
          Manage your store — products, orders, customers and AI-powered content
        </motion.p>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-6">
        <Select value={selectedSite} onValueChange={setSelectedSite}>
          <SelectTrigger className="w-[200px]"><SelectValue placeholder="Select site" /></SelectTrigger>
          <SelectContent>{sites.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
        </Select>
        <Button onClick={() => { loadStats(); loadProducts(); loadOrders(); }} variant="outline" size="sm" disabled={!selectedSite}>
          <RefreshCw size={14} className="mr-2" />Refresh
        </Button>
        <Button onClick={handleBulkDescriptions} disabled={!selectedSite || !products.length}
          className="border-primary/30 text-primary" variant="outline" size="sm">
          <Bot size={14} className="mr-2" />Bulk AI Descriptions
        </Button>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        {statCards.map(s => (
          <Card key={s.label} className="stat-card">
            <s.icon size={16} className="text-primary mb-1" />
            <p className="stat-value">{s.value}</p>
            <p className="stat-label">{s.label}</p>
          </Card>
        ))}
      </div>

      {/* Low-stock banner */}
      {lowStock.length > 0 && (
        <Card className="content-card mb-6 border-orange-500/30">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle size={14} className="text-orange-400" />
              <span className="text-sm font-medium text-orange-400">{lowStock.length} low-stock product(s)</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {lowStock.map(p => (
                <Badge key={p.id} variant="outline" className="text-xs border-orange-500/30 text-orange-400">
                  {p.name} — {p.stock_quantity} left
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="mb-4">
          <TabsTrigger value="products"><Package size={14} className="mr-2" />Products ({products.length})</TabsTrigger>
          <TabsTrigger value="orders"><ShoppingCart size={14} className="mr-2" />Orders ({orders.length})</TabsTrigger>
          <TabsTrigger value="customers"><Users size={14} className="mr-2" />Customers ({customers.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="products">
          {loading.products ? (
            <div className="flex justify-center py-12"><Loader2 size={24} className="animate-spin text-primary" /></div>
          ) : (
            <div className="space-y-2">
              {products.map(p => (
                <Card key={p.id} className="content-card">
                  <CardContent className="p-4">
                    <div className="flex items-start gap-4">
                      {p.images?.[0]?.src ? (
                        <img src={p.images[0].src} alt={p.name} className="w-14 h-14 object-cover rounded" />
                      ) : (
                        <div className="w-14 h-14 bg-muted/30 rounded flex items-center justify-center">
                          <Package size={18} className="text-muted-foreground/40" />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="font-medium text-sm">{p.name}</span>
                          <Badge variant="outline" className={`text-xs ${STATUS_COLORS[p.status] || ""}`}>{p.status}</Badge>
                          {p.stock_status === "outofstock" && <Badge variant="outline" className="text-xs border-red-500/30 text-red-400">Out of stock</Badge>}
                        </div>
                        <p className="text-xs text-muted-foreground">${p.price || "0"} · SKU: {p.sku || "—"} · Stock: {p.stock_quantity ?? "—"}</p>
                        <p className="text-xs text-muted-foreground mt-1 line-clamp-2" dangerouslySetInnerHTML={{ __html: p.short_description || p.description || "" }} />
                      </div>
                      <Button variant="outline" size="sm" className="h-7 text-xs flex-shrink-0"
                        disabled={rewritingId === p.id}
                        onClick={() => handleRewriteDescription(p.id)}>
                        {rewritingId === p.id ? <Loader2 size={12} className="animate-spin mr-1" /> : <Bot size={12} className="mr-1" />}
                        AI Rewrite
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
              {products.length === 0 && (
                <div className="text-center py-12 text-muted-foreground text-sm">{selectedSite ? "No products found" : "Select a site"}</div>
              )}
            </div>
          )}
        </TabsContent>

        <TabsContent value="orders">
          {loading.orders ? (
            <div className="flex justify-center py-12"><Loader2 size={24} className="animate-spin text-primary" /></div>
          ) : (
            <div className="space-y-2">
              {orders.map(o => (
                <Card key={o.id} className="content-card">
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <span className="font-medium text-sm">Order #{o.id}</span>
                          <Badge variant="outline" className={`text-xs ${STATUS_COLORS[o.status] || ""}`}>{o.status}</Badge>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {o.billing?.first_name} {o.billing?.last_name} · {o.billing?.email}
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {new Date(o.date_created).toLocaleDateString()} · {o.line_items?.length || 0} item(s)
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="font-semibold text-sm">${o.total}</p>
                        <p className="text-xs text-muted-foreground">{o.currency}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
              {orders.length === 0 && (
                <div className="text-center py-12 text-muted-foreground text-sm">{selectedSite ? "No orders found" : "Select a site"}</div>
              )}
            </div>
          )}
        </TabsContent>

        <TabsContent value="customers">
          {loading.customers ? (
            <div className="flex justify-center py-12"><Loader2 size={24} className="animate-spin text-primary" /></div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {customers.map(c => (
                <Card key={c.id} className="content-card">
                  <CardContent className="p-4">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-full bg-primary/20 flex items-center justify-center text-sm font-semibold text-primary flex-shrink-0">
                        {(c.first_name?.[0] || c.email?.[0] || "?").toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <p className="font-medium text-sm">{c.first_name} {c.last_name}</p>
                        <p className="text-xs text-muted-foreground truncate">{c.email}</p>
                        <p className="text-xs text-muted-foreground">Orders: {c.orders_count || 0} · Spent: ${c.total_spent || 0}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
              {customers.length === 0 && (
                <div className="col-span-2 text-center py-12 text-muted-foreground text-sm">{selectedSite ? "No customers found" : "Select a site"}</div>
              )}
            </div>
          )}
        </TabsContent>
      </Tabs>

      <SSEProgressDrawer tasks={tasks} dismissTask={dismissTask} />
    </div>
  );
}
