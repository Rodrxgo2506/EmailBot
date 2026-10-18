/*
 * Calendar arithmetic for the date picker, on "yyyy-mm-dd" day keys (the
 * value format of the former <input type="date">, local calendar day, no time
 * zone conversion). Weeks start on Monday (Spanish convention).
 */

export interface MonthRef {
  year: number;
  /** 0 = January. */
  month: number;
}

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad = (value: number) => String(value).padStart(2, "0");

/** Local date of a valid day key, or null. */
export function parseDayKey(value: string | null | undefined): Date | null {
  const match = value ? DAY_KEY.exec(value) : null;
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

export function toDayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function addDays(key: string, days: number): string {
  const date = parseDayKey(key);
  if (!date) return key;
  return toDayKey(new Date(date.getFullYear(), date.getMonth(), date.getDate() + days));
}

export function daysInMonth({ year, month }: MonthRef): number {
  return new Date(year, month + 1, 0).getDate();
}

export function shiftMonth({ year, month }: MonthRef, delta: number): MonthRef {
  const date = new Date(year, month + delta, 1);
  return { year: date.getFullYear(), month: date.getMonth() };
}

/** Same day of the month `delta` months later, clamped to the month's length (31 Jan + 1 = 28/29 Feb). */
export function addMonthsToDay(key: string, delta: number): string {
  const date = parseDayKey(key);
  if (!date) return key;
  const target = shiftMonth({ year: date.getFullYear(), month: date.getMonth() }, delta);
  const day = Math.min(date.getDate(), daysInMonth(target));
  return toDayKey(new Date(target.year, target.month, day));
}

export function monthOf(key: string): MonthRef | null {
  const date = parseDayKey(key);
  return date ? { year: date.getFullYear(), month: date.getMonth() } : null;
}

/** Monday-based column (0 = Monday ... 6 = Sunday). */
export function weekdayIndex(key: string): number {
  const date = parseDayKey(key);
  return date ? (date.getDay() + 6) % 7 : 0;
}

/**
 * The month as 6 weeks of 7 cells (Monday first): day keys of the month, null
 * for the cells before the 1st and after the last day (always 6 rows, so the
 * panel keeps its height while navigating).
 */
export function monthGrid(month: MonthRef): Array<Array<string | null>> {
  const first = toDayKey(new Date(month.year, month.month, 1));
  const lead = weekdayIndex(first);
  const total = daysInMonth(month);
  const cells: Array<string | null> = [];
  for (let index = 0; index < 42; index += 1) {
    const day = index - lead + 1;
    cells.push(day >= 1 && day <= total ? toDayKey(new Date(month.year, month.month, day)) : null);
  }
  return Array.from({ length: 6 }, (_, week) => cells.slice(week * 7, week * 7 + 7));
}

export type TypedDay = { ok: true; key: string } | { ok: false; reason: "empty" | "format" | "nonexistent" };

const TYPED_DMY = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/;
const TYPED_ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const TYPED_DIGITS = /^(\d{2})(\d{2})(\d{4})$/;

/**
 * A day typed by hand: "dd/mm/aaaa" (also with "-" or "." and 1-digit day / month),
 * "ddmmaaaa" (numeric keypad) or "aaaa-mm-dd". Returns the local day key, or
 * why it is not a day: empty, incomplete / unknown format, or a day that does
 * not exist (31/02/2026). No time zone is involved: it is a calendar day.
 */
export function parseTypedDay(text: string): TypedDay {
  const value = text.trim();
  if (!value) return { ok: false, reason: "empty" };
  let parts: [string, string, string] | null = null;
  const iso = TYPED_ISO.exec(value);
  const dmy = TYPED_DMY.exec(value) ?? TYPED_DIGITS.exec(value);
  if (iso) parts = [iso[1] as string, iso[2] as string, iso[3] as string];
  else if (dmy) parts = [dmy[3] as string, dmy[2] as string, dmy[1] as string];
  if (!parts) return { ok: false, reason: "format" };
  const key = `${parts[0]}-${parts[1].padStart(2, "0")}-${parts[2].padStart(2, "0")}`;
  return parseDayKey(key) ? { ok: true, key } : { ok: false, reason: "nonexistent" };
}

/** "17/10/2026": a day key in the format the date field accepts by hand, or "" for an empty / invalid value. */
export function formatDayInput(key: string): string {
  return parseDayKey(key) ? `${key.slice(8, 10)}/${key.slice(5, 7)}/${key.slice(0, 4)}` : "";
}

/** Day key outside [min, max] (either bound optional, inclusive). Keys compare as strings. */
export function isOutOfRange(key: string, min?: string, max?: string): boolean {
  return (Boolean(min) && key < (min as string)) || (Boolean(max) && key > (max as string));
}

const titleFormatter = new Intl.DateTimeFormat("es", { month: "long", year: "numeric" });
const valueFormatter = new Intl.DateTimeFormat("es", { day: "numeric", month: "short", year: "numeric" });
const fullFormatter = new Intl.DateTimeFormat("es", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const weekdayFormatter = new Intl.DateTimeFormat("es", { weekday: "long" });
const narrowWeekdayFormatter = new Intl.DateTimeFormat("es", { weekday: "narrow" });

const capitalize = (text: string) => text.charAt(0).toLocaleUpperCase("es") + text.slice(1);

/** "Octubre de 2026". */
export function monthTitle({ year, month }: MonthRef): string {
  return capitalize(titleFormatter.format(new Date(year, month, 1)));
}

/** "1 oct 2026" (shown on the control), or "" for an empty / invalid value. */
export function formatDayValue(key: string): string {
  const date = parseDayKey(key);
  return date ? valueFormatter.format(date).replace(/\.(?=\s|$)/g, "") : "";
}

/** "jueves, 1 de octubre de 2026" (accessible name of a day). */
export function formatDayLong(key: string): string {
  const date = parseDayKey(key);
  return date ? fullFormatter.format(date) : key;
}

/** Monday-first weekday names: [{ short: "L", long: "lunes" }, ...]. 5 Oct 2026 is a Monday. */
export const WEEKDAYS = Array.from({ length: 7 }, (_, index) => {
  const date = new Date(2026, 9, 5 + index);
  return { short: narrowWeekdayFormatter.format(date).toLocaleUpperCase("es"), long: weekdayFormatter.format(date) };
});
