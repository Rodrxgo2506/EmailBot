import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

const dateTimeFormatter = new Intl.DateTimeFormat("es", { dateStyle: "medium", timeStyle: "short" });
const timeFormatter = new Intl.DateTimeFormat("es", { hour: "2-digit", minute: "2-digit" });
const shortDateFormatter = new Intl.DateTimeFormat("es", { day: "numeric", month: "short" });

function parse(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDate(value: string | null | undefined): string {
  const date = parse(value);
  return date ? dateTimeFormatter.format(date) : "—";
}

/** Compact date for lists: time for today, day + month otherwise. */
export function formatShortDate(value: string | null | undefined, now = new Date()): string {
  const date = parse(value);
  if (!date) return "—";
  return date.toDateString() === now.toDateString() ? timeFormatter.format(date) : shortDateFormatter.format(date);
}

export function initials(name: string | null | undefined, fallback = "?"): string {
  const source = (name ?? "").trim();
  if (!source) return fallback;
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || fallback;
}
