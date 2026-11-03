import { MoreVertical } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { floatingPanelClass, floatingPanelStyle, useFloatingPanel } from "./floating-panel";

export interface ActionsMenuItem {
  label: string;
  icon?: ReactNode;
  /** Danger styling (destructive actions: they still open their own confirmation). */
  destructive?: boolean;
  onSelect(): void;
}

export interface ActionsMenuProps {
  /** Accessible name of the trigger ("Acciones de Juan Pérez"). */
  label: string;
  items: ActionsMenuItem[];
  className?: string;
}

/**
 * Row actions behind a "three dots" button (WAI-ARIA menu button pattern),
 * on the same floating panel as SelectMenu. Mouse: click to open / choose, a
 * press outside closes. Keyboard: Enter / Space / Arrow keys open it with
 * focus on an item; inside, Arrow keys, Home / End move, Enter / Space
 * choose, Escape closes (focus back on the button), Tab closes and moves on.
 * Choosing an item only closes the menu and calls onSelect.
 */
export function ActionsMenu({ label, items, className }: ActionsMenuProps) {
  const id = useId();
  const menuId = `${id}-menu`;
  const { phase, mounted, isOpen, open, close, rootRef, panelRef, placement } = useFloatingPanel<HTMLUListElement>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (isOpen) panelRef.current?.focus();
  }, [isOpen, panelRef]);

  const openAt = (index: number) => {
    if (items.length === 0) return;
    setActive(Math.min(Math.max(index, 0), items.length - 1));
    open();
  };
  const dismiss = (refocus: boolean) => {
    close();
    if (refocus) triggerRef.current?.focus();
  };
  const choose = (index: number) => {
    const item = items[index];
    if (!item) return;
    dismiss(true);
    item.onSelect();
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      openAt(0);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      openAt(items.length - 1);
    }
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const last = items.length - 1;
    const move = (index: number) => {
      event.preventDefault();
      setActive(index < 0 ? last : index > last ? 0 : index);
    };
    switch (event.key) {
      case "ArrowDown":
        return move(active + 1);
      case "ArrowUp":
        return move(active - 1);
      case "Home":
        return move(0);
      case "End":
        return move(last);
      case "Enter":
      case " ":
        event.preventDefault();
        return choose(active);
      case "Escape":
        event.preventDefault();
        return dismiss(true);
      case "Tab":
        return dismiss(false);
    }
  };

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={mounted ? menuId : undefined}
        onClick={() => (isOpen ? dismiss(false) : openAt(0))}
        onKeyDown={onTriggerKeyDown}
        className={cn(
          "flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors",
          "hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          isOpen && "bg-accent text-accent-foreground"
        )}
      >
        <MoreVertical aria-hidden className="size-4" />
      </button>

      {mounted ? (
        <ul
          ref={panelRef}
          id={menuId}
          role="menu"
          aria-label={label}
          aria-activedescendant={isOpen ? `${menuId}-${active}` : undefined}
          aria-hidden={phase === "closing" ? true : undefined}
          tabIndex={-1}
          style={floatingPanelStyle(placement)}
          onKeyDown={onMenuKeyDown}
          onBlur={(event) => {
            if (!rootRef.current?.contains(event.relatedTarget as Node | null)) close();
          }}
          className={cn(
            floatingPanelClass(phase, placement),
            "w-max min-w-44 rounded-xl border bg-card p-1.5 text-card-foreground shadow-pop focus:outline-none"
          )}
        >
          {items.map((item, index) => (
            <li
              key={item.label}
              id={`${menuId}-${index}`}
              role="menuitem"
              onMouseMove={() => setActive(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(index)}
              className={cn(
                "flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors select-none [&_svg]:size-4 [&_svg]:shrink-0",
                item.destructive ? "text-destructive" : "text-foreground",
                index === active && (item.destructive ? "bg-destructive/10" : "bg-muted"),
                index === active && "outline-2 -outline-offset-2 outline-primary/40 [ul:not(:focus-visible)_&]:outline-none"
              )}
            >
              {item.icon ? <span aria-hidden className="flex">{item.icon}</span> : null}
              <span className="min-w-0 flex-1">{item.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
