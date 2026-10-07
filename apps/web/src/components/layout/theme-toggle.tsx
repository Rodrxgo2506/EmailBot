import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

/** Navbar control: shows the action (moon in light mode, sun in dark mode) and switches the whole app. */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, toggleTheme } = useTheme();
  const dark = theme === "dark";
  const label = dark ? "Cambiar a modo claro" : "Cambiar a modo nocturno";

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      onClick={toggleTheme}
      className={cn("relative overflow-hidden text-muted-foreground hover:text-foreground", className)}
    >
      <Sun
        aria-hidden
        className={cn("absolute transition-all duration-300 ease-out", dark ? "rotate-0 scale-100 opacity-100" : "-rotate-90 scale-50 opacity-0")}
      />
      <Moon
        aria-hidden
        className={cn("absolute transition-all duration-300 ease-out", dark ? "rotate-90 scale-50 opacity-0" : "rotate-0 scale-100 opacity-100")}
      />
    </Button>
  );
}
