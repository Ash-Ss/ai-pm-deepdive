/** Time and date helpers. All dates are ISO "YYYY-MM-DD" handled in UTC so weekday math never shifts with the host timezone. */
import type { Weekday } from "../types";

export const WEEKDAYS: Weekday[] = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

export function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** Minutes since midnight → "HH:MM". Clamped to the same day because Item times are same-day. */
export function fromMin(min: number): string {
  const m = Math.max(0, Math.min(23 * 60 + 59, Math.round(min)));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

const parse = (iso: string) => new Date(`${iso}T00:00:00Z`);

export function weekdayOf(iso: string): Weekday {
  // JS getUTCDay: 0 = Sunday.
  return WEEKDAYS[(parse(iso).getUTCDay() + 6) % 7];
}

export function addDays(iso: string, n: number): string {
  const d = parse(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function monthOf(iso: string): number {
  return parse(iso).getUTCMonth() + 1;
}

export function overlapMin(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

/** Next date on or after `fromIso` that falls on `weekday`, strictly after if `strict`. */
export function nextWeekday(fromIso: string, weekday: Weekday, strict = true): string {
  let d = strict ? addDays(fromIso, 1) : fromIso;
  while (weekdayOf(d) !== weekday) d = addDays(d, 1);
  return d;
}
