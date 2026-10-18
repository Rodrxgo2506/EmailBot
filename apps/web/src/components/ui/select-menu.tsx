import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { floatingPanelClass, floatingPanelStyle, useFloatingPanel } from "./floating-panel";

export interface SelectMenuOption {
  value: string;
  label: string;
  icon?: ReactNode;
}

export interface SelectMenuProps {
  /** Accessible name of the control ("Categoría"); the selected option is announced after it. */
  label: string;
  value: string;
  options: SelectMenuOption[];
  onValueChange(value: string): void;
  disabled?: boolean;
  className?: string;
}

/**
 * Compact select with a floating option list (WAI-ARIA listbox pattern): a
 * button shows the selected option; the list opens below it with icons, the
 * selected option highlighted and checked. Mouse: click to open / choose, a
 * press outside closes. Keyboard: Arrow keys / Enter / Space open it; inside,
 * Arrow keys, Home / End and the first letter move, Enter / Space choose,
 * Escape closes (focus back on the button), Tab closes and moves on.
 */
export function SelectMenu({ label, value, options, onValueChange, disabled, className }: SelectMenuProps) {
  const id = useId();
  const labelId = `${id}-label`;
  const valueId = `${id}-value`;
  const listId = `${id}-list`;
  const { phase, mounted, isOpen, open, close, rootRef, panelRef, placement } = useFloatingPanel<HTMLUListElement>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value)
  );
  const selected = options.find((option) => option.value === value) ?? options[0];
  const [active, setActive] = useState(selectedIndex);

  // Focus moves into the list when it opens (the active option is announced through aria-activedescendant).
  useEffect(() => {
    if (isOpen) panelRef.current?.focus();
  }, [isOpen, panelRef]);

  const openAt = (index: number) => {
    if (disabled || options.length === 0) return;
    setActive(Math.min(Math.max(index, 0), options.length - 1));
    open();
  };
  const dismiss = (refocus: boolean) => {
    close();
    if (refocus) triggerRef.current?.focus();
  };
  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    if (option.value !== value) onValueChange(option.value);
    dismiss(true);
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      openAt(selectedIndex);
    }
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const last = options.length - 1;
    const move = (index: number) => {
      event.preventDefault();
      setActive(Math.min(Math.max(index, 0), last));
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
      default:
        if (event.key.length === 1 && /\S/.test(event.key)) {
          const letter = event.key.toLocaleLowerCase("es");
          const order = [...options.slice(active + 1), ...options.slice(0, active + 1)];
          const match = order.find((option) => option.label.toLocaleLowerCase("es").startsWith(letter));
          if (match) move(options.indexOf(match));
        }
    }
  };

  // Keep the active option visible while moving with the keyboard.
  useEffect(() => {
    if (!isOpen) return;
    const node = document.getElementById(`${listId}-${active}`);
    node?.scrollIntoView?.({ block: "nearest" });
  }, [active, isOpen, listId]);

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <span id={labelId} className="sr-only">
        {label}
      </span>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={mounted ? listId : undefined}
        aria-labelledby={`${labelId} ${valueId}`}
        onClick={() => (isOpen ? dismiss(false) : openAt(selectedIndex))}
        onKeyDown={onTriggerKeyDown}
        className={cn(
          "flex h-10 w-full items-center gap-2 rounded-lg border border-input bg-card px-3 text-left text-sm shadow-xs transition-colors",
          "hover:border-primary/40 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25",
          "disabled:cursor-not-allowed disabled:opacity-60",
          isOpen && "border-primary ring-3 ring-ring/20"
        )}
      >
        {selected?.icon ? <span className="flex shrink-0 text-primary [&_svg]:size-4">{selected.icon}</span> : null}
        <span id={valueId} className="min-w-0 flex-1 truncate font-medium">
          {selected?.label ?? ""}
        </span>
        <ChevronDown aria-hidden className={cn("size-4 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-180")} />
      </button>

      {mounted ? (
        <ul
          ref={panelRef}
          id={listId}
          role="listbox"
          aria-labelledby={labelId}
          aria-activedescendant={isOpen ? `${listId}-${active}` : undefined}
          aria-hidden={phase === "closing" ? true : undefined}
          tabIndex={-1}
          style={floatingPanelStyle(placement)}
          onKeyDown={onListKeyDown}
          onBlur={(event) => {
            if (!rootRef.current?.contains(event.relatedTarget as Node | null)) close();
          }}
          className={cn(
            floatingPanelClass(phase, placement),
            "max-h-72 w-max min-w-full max-w-[min(22rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border bg-card p-1.5 text-card-foreground shadow-pop focus:outline-none"
          )}
        >
          {options.map((option, index) => {
            const isSelected = option.value === value;
            return (
              <li
                key={option.value || "__all"}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={isSelected}
                onMouseMove={() => setActive(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(index)}
                className={cn(
                  "flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-sm transition-colors select-none",
                  index === active && !isSelected && "bg-muted",
                  isSelected ? "bg-accent font-semibold text-accent-foreground" : "text-foreground",
                  index === active && "outline-2 -outline-offset-2 outline-primary/40 [ul:not(:focus-visible)_&]:outline-none"
                )}
              >
                {option.icon ? (
                  <span
                    aria-hidden
                    className={cn(
                      "flex size-8 shrink-0 items-center justify-center rounded-lg [&_svg]:size-4",
                      isSelected ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                    )}
                  >
                    {option.icon}
                  </span>
                ) : null}
                <span className="min-w-0 flex-1 whitespace-normal break-words">{option.label}</span>
                <Check aria-hidden className={cn("size-4 shrink-0 text-primary", !isSelected && "invisible")} />
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
