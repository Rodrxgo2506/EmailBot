import { cn } from "@/lib/utils";

/*
 * Official EmailBot logo, two renditions of the same artwork (PNG 2171 x 724 with transparency):
 *  - emailbot-logo-oficial.png        original, white "Email": dark colour scheme;
 *  - emailbot-logo-oficial-light.png  same file with the "Email" lettering in dark blue (envelope and "Bot"
 *                                     unchanged): light colour scheme, the default.
 * The choice follows `prefers-color-scheme`, the same switch the theme tokens use (index.css).
 */
export const BRAND_LOGO_SRC = `${import.meta.env.BASE_URL}emailbot-logo-oficial.png`;
export const BRAND_LOGO_LIGHT_SRC = `${import.meta.env.BASE_URL}emailbot-logo-oficial-light.png`;
const BRAND_LOGO_WIDTH = 2171;
const BRAND_LOGO_HEIGHT = 724;

/**
 * Renders the official logo as-is: height set by `className` (e.g. "h-9"), width follows the original 3:1
 * ratio, `object-contain` never crops or stretches it. The intrinsic size avoids a layout shift while it loads.
 */
export function BrandLogo({ className }: { className?: string }) {
  return (
    <picture className="contents">
      <source media="(prefers-color-scheme: dark)" srcSet={BRAND_LOGO_SRC} width={BRAND_LOGO_WIDTH} height={BRAND_LOGO_HEIGHT} />
      <img
        src={BRAND_LOGO_LIGHT_SRC}
        alt="EmailBot"
        width={BRAND_LOGO_WIDTH}
        height={BRAND_LOGO_HEIGHT}
        decoding="async"
        draggable={false}
        className={cn("block h-10 w-auto max-w-full select-none object-contain", className)}
      />
    </picture>
  );
}
