import { CalendarDays, ChevronLeft, ChevronRight, Info } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import {
  addDays,
  addMonthsToDay,
  daysInMonth,
  formatDayInput,
  formatDayLong,
  formatDayValue,
  isOutOfRange,
  monthGrid,
  monthOf,
  monthTitle,
  parseDayKey,
  parseTypedDay,
  shiftMonth,
  toDayKey,
  weekdayIndex,
  WEEKDAYS,
  type MonthRef
} from "./date-picker-model";
import { floatingPanelClass, floatingPanelStyle, useFloatingPanel } from "./floating-panel";

export interface DatePickerProps {
  /** Accessible name ("Desde"); also the placeholder when no date is set. */
  label: string;
  /** "yyyy-mm-dd" or "" (no date). */
  value: string;
  onChange(value: string): void;
  /** Inclusive bounds ("yyyy-mm-dd"): days outside them cannot be chosen. */
  min?: string;
  max?: string;
  /** Why min / max exist ("Hasta no puede ser anterior a Desde."); shown in the open calendar only while a bound applies. */
  rangeHint?: string;
  className?: string;
}

/**
 * Date field with a floating month calendar (non-modal dialog + ARIA grid).
 * The value stays a local "yyyy-mm-dd" day, exactly like the native date input
 * it replaces. Month arrows navigate without selecting; a day click selects
 * and closes; "Eliminar fecha" clears. Keyboard in the grid: arrows (day /
 * week), Home / End (week), PageUp / PageDown (month, + Shift: year),
 * Enter / Space select, Escape closes with the focus back on the field.
 * Below the grid the day can also be typed ("dd/mm/aaaa", Enter or "Aplicar"):
 * incomplete, non-existent and out-of-range days are explained, not applied.
 */
export function DatePicker({ label, value, onChange, min, max, rangeHint, className }: DatePickerProps) {
  const id = useId();
  const labelId = `${id}-label`;
  const valueId = `${id}-value`;
  const titleId = `${id}-title`;
  const dialogId = `${id}-dialog`;
  const typedId = `${id}-typed`;
  const typedErrorId = `${id}-typed-error`;
  const hintId = `${id}-hint`;
  const { phase, mounted, isOpen, open, close, rootRef, panelRef, placement } = useFloatingPanel<HTMLDivElement>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const focusPending = useRef(false);
  const [today, setToday] = useState(() => toDayKey(new Date()));
  const [view, setView] = useState<MonthRef>(() => monthOf(value) ?? monthOf(toDayKey(new Date())) ?? { year: 2026, month: 0 });
  const [focusDay, setFocusDay] = useState("");
  const [typed, setTyped] = useState("");
  const [typedError, setTypedError] = useState<string | null>(null);
  const hasValue = parseDayKey(value) !== null;
  const bounded = Boolean(min || max);
  const hint = bounded ? rangeHint ?? boundsText(min, max) : null;

  // Keyboard navigation in the grid moves the DOM focus once the target day is rendered.
  useEffect(() => {
    if (!isOpen || !focusPending.current) return;
    focusPending.current = false;
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-day="${focusDay}"]`)?.focus();
  });

  const openPicker = () => {
    const now = toDayKey(new Date());
    setToday(now);
    let start = hasValue ? value : now;
    if (!hasValue && min && start < min) start = min;
    if (!hasValue && max && start > max) start = max;
    setFocusDay(start);
    setView(monthOf(start) ?? view);
    setTyped(formatDayInput(value));
    setTypedError(null);
    focusPending.current = true;
    open();
  };
  const dismiss = (refocus: boolean) => {
    close();
    if (refocus) triggerRef.current?.focus();
  };
  const select = (key: string) => {
    if (isOutOfRange(key, min, max)) return;
    if (key !== value) onChange(key);
    dismiss(true);
  };
  const clear = () => {
    if (value) onChange("");
    dismiss(true);
  };
  /** Month arrows: show another month without selecting anything (the focus stays on the arrow). */
  const goMonth = (delta: number) => {
    const next = shiftMonth(view, delta);
    setView(next);
    const day = Math.min(parseDayKey(focusDay)?.getDate() ?? 1, daysInMonth(next));
    setFocusDay(toDayKey(new Date(next.year, next.month, day)));
  };
  const moveFocus = (key: string) => {
    const month = monthOf(key);
    if (!month) return;
    setFocusDay(key);
    if (month.year !== view.year || month.month !== view.month) setView(month);
    focusPending.current = true;
  };

  /** While typing, a complete real day shows its month (nothing is selected until Enter / "Aplicar"). */
  const onTypedChange = (text: string) => {
    setTyped(text);
    setTypedError(null);
    const parsed = parseTypedDay(text);
    const month = parsed.ok ? monthOf(parsed.key) : null;
    if (parsed.ok && month) {
      setView(month);
      setFocusDay(parsed.key);
    }
  };
  const applyTyped = () => {
    const parsed = parseTypedDay(typed);
    if (!parsed.ok) {
      setTypedError(parsed.reason === "nonexistent" ? "Esa fecha no existe." : "Escribe la fecha completa: dd/mm/aaaa.");
      return;
    }
    if (min && parsed.key < min) return setTypedError(`Elige una fecha desde el ${formatDayValue(min)}.`);
    if (max && parsed.key > max) return setTypedError(`Elige una fecha hasta el ${formatDayValue(max)}.`);
    select(parsed.key);
  };

  const onGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const from = focusDay || today;
    const steps: Record<string, () => string> = {
      ArrowLeft: () => addDays(from, -1),
      ArrowRight: () => addDays(from, 1),
      ArrowUp: () => addDays(from, -7),
      ArrowDown: () => addDays(from, 7),
      Home: () => addDays(from, -weekdayIndex(from)),
      End: () => addDays(from, 6 - weekdayIndex(from)),
      PageUp: () => addMonthsToDay(from, event.shiftKey ? -12 : -1),
      PageDown: () => addMonthsToDay(from, event.shiftKey ? 12 : 1)
    };
    const step = steps[event.key];
    if (!step) return;
    event.preventDefault();
    moveFocus(step());
  };

  const weeks = monthGrid(view);
  const visibleDays = weeks.flat().filter((key): key is string => key !== null);
  const tabStop = visibleDays.includes(focusDay) ? focusDay : (visibleDays[0] ?? "");

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <span id={labelId} className="sr-only">
        {label}
      </span>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls={mounted ? dialogId : undefined}
        aria-labelledby={`${labelId} ${valueId}`}
        onClick={() => (isOpen ? dismiss(false) : openPicker())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !isOpen) {
            event.preventDefault();
            openPicker();
          }
        }}
        className={cn(
          "flex h-10 w-full items-center gap-2 rounded-lg border border-input bg-card px-3 text-left text-sm shadow-xs transition-colors",
          "hover:border-primary/40 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25",
          isOpen && "border-primary ring-3 ring-ring/20"
        )}
      >
        <CalendarDays aria-hidden className={cn("size-4 shrink-0", hasValue ? "text-primary" : "text-muted-foreground")} />
        <span id={valueId} className={cn("min-w-0 flex-1 truncate", hasValue ? "font-medium" : "text-muted-foreground")}>
          {hasValue ? formatDayValue(value) : <span className="sr-only">sin fecha</span>}
          {hasValue ? null : <span aria-hidden>{label}</span>}
        </span>
      </button>

      {mounted ? (
        <div
          ref={panelRef}
          id={dialogId}
          role="dialog"
          aria-modal="false"
          aria-labelledby={`${labelId} ${titleId}`}
          aria-describedby={hint ? hintId : undefined}
          aria-hidden={phase === "closing" ? true : undefined}
          tabIndex={-1}
          style={floatingPanelStyle(placement)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              dismiss(true);
            }
          }}
          onBlur={(event) => {
            if (!rootRef.current?.contains(event.relatedTarget as Node | null)) close();
          }}
          className={cn(
            floatingPanelClass(phase, placement),
            "w-[18.5rem] max-w-[calc(100vw-2rem)] rounded-2xl border bg-card p-3 text-card-foreground shadow-pop focus:outline-none"
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              aria-label="Mes anterior"
              onClick={() => goMonth(-1)}
              className="flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronLeft aria-hidden className="size-4" />
            </button>
            <h2 id={titleId} aria-live="polite" className="text-sm font-semibold tracking-tight">
              {monthTitle(view)}
            </h2>
            <button
              type="button"
              aria-label="Mes siguiente"
              onClick={() => goMonth(1)}
              className="flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronRight aria-hidden className="size-4" />
            </button>
          </div>

          <div ref={gridRef} role="grid" aria-labelledby={titleId} onKeyDown={onGridKeyDown} className="mt-2">
            <div role="row" className="grid grid-cols-7">
              {WEEKDAYS.map((weekday) => (
                <span key={weekday.long} role="columnheader" aria-label={weekday.long} className="py-1.5 text-center text-xs font-semibold text-muted-foreground">
                  <span aria-hidden>{weekday.short}</span>
                </span>
              ))}
            </div>
            {weeks.map((week, row) => (
              <div key={row} role="row" className="grid grid-cols-7">
                {week.map((key, column) => {
                  if (!key) return <span key={`empty-${row}-${column}`} role="gridcell" className="h-9" />;
                  const disabled = isOutOfRange(key, min, max);
                  const selected = key === value;
                  const isToday = key === today;
                  return (
                    <span key={key} role="gridcell" aria-selected={selected} className="flex justify-center py-0.5">
                      <button
                        type="button"
                        data-day={key}
                        tabIndex={key === tabStop ? 0 : -1}
                        aria-label={formatDayLong(key)}
                        aria-current={isToday ? "date" : undefined}
                        aria-disabled={disabled || undefined}
                        aria-describedby={disabled && hint ? hintId : undefined}
                        onClick={() => select(key)}
                        onFocus={() => setFocusDay(key)}
                        className={cn(
                          "relative flex size-9 items-center justify-center rounded-lg text-sm tabular-nums transition-colors",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card",
                          selected && "bg-primary font-semibold text-primary-foreground shadow-sm hover:bg-primary/90",
                          !selected && !disabled && "text-foreground hover:bg-accent hover:text-accent-foreground",
                          !selected && isToday && "font-semibold text-primary ring-1 ring-inset ring-primary/45",
                          disabled && "cursor-not-allowed text-muted-foreground/55 line-through decoration-muted-foreground/40 hover:bg-transparent"
                        )}
                      >
                        {Number(key.slice(8))}
                      </button>
                    </span>
                  );
                })}
              </div>
            ))}
          </div>

          <div className="mt-2 border-t pt-2.5">
            <label htmlFor={typedId} className="sr-only">
              Escribir fecha (dd/mm/aaaa)
            </label>
            <div className="flex items-center gap-2">
              <input
                id={typedId}
                type="text"
                autoComplete="off"
                spellCheck={false}
                enterKeyHint="done"
                placeholder="dd/mm/aaaa"
                value={typed}
                onChange={(event) => onTypedChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    applyTyped();
                  }
                }}
                aria-invalid={typedError ? true : undefined}
                aria-describedby={typedError ? typedErrorId : undefined}
                className={cn(
                  "h-9 min-w-0 flex-1 rounded-lg border border-input bg-card px-2.5 text-sm tabular-nums shadow-xs transition-colors placeholder:text-muted-foreground",
                  "focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
                  typedError && "border-destructive"
                )}
              />
              <button
                type="button"
                onClick={applyTyped}
                className="h-9 shrink-0 rounded-lg border border-primary/30 px-3 text-sm font-medium text-primary transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Aplicar
              </button>
            </div>
            {typedError ? (
              <p id={typedErrorId} role="alert" className="mt-1.5 text-xs text-destructive">
                {typedError}
              </p>
            ) : null}
            {hint ? (
              <p id={hintId} className="mt-1.5 flex items-start gap-1.5 text-xs text-muted-foreground">
                <Info aria-hidden className="mt-px size-3.5 shrink-0" />
                <span>{hint}</span>
              </p>
            ) : null}
          </div>

          <div className="mt-2 flex items-center justify-between border-t pt-2">
            <span className="text-xs text-muted-foreground">{hasValue ? formatDayValue(value) : "Sin fecha"}</span>
            <button
              type="button"
              onClick={clear}
              disabled={!hasValue}
              className="rounded-md px-2 py-1 text-sm font-medium text-primary transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:text-muted-foreground disabled:hover:bg-transparent"
            >
              Eliminar fecha
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Default explanation of the bounds ("Fechas disponibles desde el 1 oct 2026."). */
function boundsText(min?: string, max?: string): string {
  if (min && max) return `Fechas disponibles del ${formatDayValue(min)} al ${formatDayValue(max)}.`;
  if (min) return `Fechas disponibles desde el ${formatDayValue(min)}.`;
  return `Fechas disponibles hasta el ${formatDayValue(max ?? "")}.`;
}
