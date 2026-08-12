import markAsset from "@/assets/insightforge-mark.png.asset.json";
import { cn } from "@/lib/utils";

/**
 * InsightForge AI brand lockup. `showText` can be disabled on tight layouts
 * (mobile headers) where only the mark should render.
 */
export function BrandLogo({
  className,
  showText = true,
  size = "md",
}: {
  className?: string;
  showText?: boolean;
  size?: "sm" | "md";
}) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2 font-semibold", className)}>
      <img
        src={markAsset.url}
        alt="InsightForge AI logo"
        className={cn("shrink-0 object-contain", size === "sm" ? "size-7" : "size-8")}
        width={32}
        height={32}
      />
      {showText && (
        <span className={cn("truncate tracking-tight", size === "sm" ? "text-sm" : "text-base")}>
          InsightForge <span className="text-gradient">AI</span>
        </span>
      )}
    </span>
  );
}
