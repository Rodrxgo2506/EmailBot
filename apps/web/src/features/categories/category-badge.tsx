import type { Category } from "@emailbot/types";
import { cn } from "@/lib/utils";

export function CategoryDot({ color, className }: { color: string | null; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-2 shrink-0 rounded-full bg-muted-foreground", className)}
      style={color ? { backgroundColor: color } : undefined}
    />
  );
}

export function CategoryBadge({ category }: { category: Category | undefined }) {
  if (!category) return null;
  return (
    <span className="inline-flex max-w-40 items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-xs">
      <CategoryDot color={category.color} />
      <span className="truncate">{category.name}</span>
    </span>
  );
}
