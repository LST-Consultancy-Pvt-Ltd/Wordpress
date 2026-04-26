import { TrendingUp, BarChart2, MousePointer, ShieldCheck } from "lucide-react";
import { Badge } from "./ui/badge";

const confidenceColors = {
  high: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20",
  medium: "bg-yellow-500/10 text-yellow-500 border-yellow-500/20",
  low: "bg-muted text-muted-foreground",
};

/**
 * ImpactBadge — displays the estimated SEO impact of an approval action.
 * @param {Object} impact - { traffic_change, ranking_impact, ctr_change, confidence }
 * @param {string} [className] - extra CSS classes
 */
export default function ImpactBadge({ impact, className = "" }) {
  if (!impact) return null;
  const { traffic_change, ranking_impact, ctr_change, confidence } = impact;

  return (
    <div className={`rounded-lg border border-border/50 bg-muted/30 px-4 py-3 space-y-2 ${className}`}>
      <div className="flex items-center gap-2">
        <TrendingUp size={14} className="text-primary" />
        <span className="text-xs font-semibold text-foreground">Estimated SEO Impact</span>
        {confidence && (
          <Badge className={`ml-auto text-[10px] px-1.5 py-0 ${confidenceColors[confidence] || confidenceColors.low}`}>
            <ShieldCheck size={9} className="mr-1" />
            {confidence} confidence
          </Badge>
        )}
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] text-muted-foreground flex items-center gap-1">
            <TrendingUp size={9} /> Traffic
          </span>
          <span className="text-xs font-medium text-emerald-500">{traffic_change}</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] text-muted-foreground flex items-center gap-1">
            <BarChart2 size={9} /> Ranking
          </span>
          <span className="text-xs font-medium text-foreground">{ranking_impact}</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] text-muted-foreground flex items-center gap-1">
            <MousePointer size={9} /> CTR
          </span>
          <span className="text-xs font-medium text-blue-500">{ctr_change}</span>
        </div>
      </div>
    </div>
  );
}
