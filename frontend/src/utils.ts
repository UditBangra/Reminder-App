import { format, formatDistanceToNowStrict, isPast, parseISO } from "date-fns";

export function fmtDate(iso: string): string {
  try {
    return format(parseISO(iso), "EEE, d MMM yyyy · h:mm a");
  } catch {
    return iso;
  }
}

/** Date only, same style as fmtDate: "Mon, 16 Nov 2026". */
export function fmtDay(d: Date): string {
  try {
    return format(d, "EEE, d MMM yyyy");
  } catch {
    return d.toDateString();
  }
}

export function fmtRelative(iso: string): string {
  try {
    const d = parseISO(iso);
    const prefix = isPast(d) ? "" : "in ";
    const suffix = isPast(d) ? " ago" : "";
    return `${prefix}${formatDistanceToNowStrict(d)}${suffix}`;
  } catch {
    return iso;
  }
}

export function toISO(d: Date): string {
  return d.toISOString();
}

export function combineDateTime(date: Date, time: Date): Date {
  const d = new Date(date);
  d.setHours(time.getHours(), time.getMinutes(), 0, 0);
  return d;
}

export function isValidEmail(value: string): boolean {
  const v = (value || "").trim();
  // Pragmatic check: non-empty local part, single @, dotted domain
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}
