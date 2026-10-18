import { cn } from "@/lib/utils";

/*
 * Official EmailBot logo, two renditions of the same artwork (PNG 2171 x 724 with transparency):
 *  - emailbot-logo-oficial.png        original, white "Email": dark theme;
 *  - emailbot-logo-oficial-light.png  same file with the "Email" lettering in dark blue (envelope and "Bot"
 *                                     unchanged): light theme.
 * The rendition follows the GLOBAL theme (<html data-theme>, the choice saved under "emailbot.theme" or else the
 * system preference, public/theme-init.js) through the `dark:` variant of index.css, like every other dark style:
 * never the operating system alone, so the logo always agrees with the page around it.
 */
export const BRAND_LOGO_SRC = `${import.meta.env.BASE_URL}emailbot-logo-oficial.png`;
export const BRAND_LOGO_LIGHT_SRC = `${import.meta.env.BASE_URL}emailbot-logo-oficial-light.png`;
const BRAND_LOGO_WIDTH = 2171;
const BRAND_LOGO_HEIGHT = 724;

const IMAGE = "h-10 w-auto max-w-full select-none object-contain";

/**
 * Renders the official logo as-is: height set by `className` (e.g. "h-9"), width follows the original 3:1
 * ratio, `object-contain` never crops or stretches it. The intrinsic size avoids a layout shift while it loads.
 * One accessible image ("EmailBot"); the two renditions inside are decorative and exactly one is displayed
 * (`dark:hidden` / `hidden dark:block`). `loading="lazy"`: the rendition that is not displayed has no layout box.
 */
export function BrandLogo({ className }: { className?: string }) {
  const image = { width: BRAND_LOGO_WIDTH, height: BRAND_LOGO_HEIGHT, alt: "", decoding: "async", loading: "lazy", draggable: false } as const;
  return (
    <span role="img" aria-label="EmailBot" className="flex max-w-full">
      <img {...image} src={BRAND_LOGO_LIGHT_SRC} data-theme-rendition="light" className={cn("block", IMAGE, "dark:hidden", className)} />
      <img {...image} src={BRAND_LOGO_SRC} data-theme-rendition="dark" className={cn("hidden", IMAGE, "dark:block", className)} />
    </span>
  );
}
