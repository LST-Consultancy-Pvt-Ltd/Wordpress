import { useParams, useSearchParams } from "react-router-dom";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { Card, CardContent } from "../../components/ui/card";
import SiteHeader from "../../components/sa/SiteHeader";
import CapabilityNotice from "../../components/sa/CapabilityNotice";
import CollectionEditor from "../../components/content/CollectionEditor";
import MetadataEditor from "../../components/content/MetadataEditor";
import BlocksEditor from "../../components/content/BlocksEditor";
import { useSite } from "../../hooks/useSite";
import { hasCapability } from "../../lib/capabilities";

const TABS = [
  { id: "collections", label: "Content", cap: "content.read" },
  { id: "blocks", label: "Blocks", cap: "blocks.write" },
  { id: "metadata", label: "Metadata", cap: "metadata.write" },
  { id: "images", label: "Image alt text", cap: "images.alt.write" },
];

export default function SiteContent() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.id === params.get("tab")) ? params.get("tab") : "collections";
  const { site, loading, error } = useSite(id);

  return (
    <div className="page-container" data-testid="site-content">
      <SiteHeader site={site} loading={loading} error={error} title="Content" />
      {site && (
        <Tabs
          value={tab}
          onValueChange={(v) => {
            const next = new URLSearchParams(params);
            next.set("tab", v);
            next.delete("route");
            setParams(next, { replace: true });
          }}
        >
          <TabsList className="mb-4">
            {TABS.map((t) => (
              <TabsTrigger key={t.id} value={t.id} data-testid={`content-tab-${t.id}`}>
                {t.label}
                {!hasCapability(site, t.cap) && <span className="sr-only"> (not available)</span>}
                {!hasCapability(site, t.cap) && <span aria-hidden="true" className="ml-1 text-muted-foreground">·</span>}
              </TabsTrigger>
            ))}
          </TabsList>
          <Card className="content-card">
            <CardContent className="p-4">
              <TabsContent value="collections" className="mt-0">
                {tab === "collections" && <CollectionEditor site={site} initialCollection={params.get("collection") || ""} />}
              </TabsContent>
              <TabsContent value="blocks" className="mt-0">
                {tab === "blocks" && (hasCapability(site, "blocks.write") ? <BlocksEditor site={site} mode="text" /> : <CapabilityNotice capability="blocks.write" site={site} />)}
              </TabsContent>
              <TabsContent value="metadata" className="mt-0">
                {tab === "metadata" && (hasCapability(site, "metadata.write") ? <MetadataEditor site={site} initialRoute={params.get("route") || ""} /> : <CapabilityNotice capability="metadata.write" site={site} />)}
              </TabsContent>
              <TabsContent value="images" className="mt-0">
                {tab === "images" && (hasCapability(site, "images.alt.write") ? <BlocksEditor site={site} mode="images" /> : <CapabilityNotice capability="images.alt.write" site={site} />)}
              </TabsContent>
            </CardContent>
          </Card>
        </Tabs>
      )}
    </div>
  );
}
