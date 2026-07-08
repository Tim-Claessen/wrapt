// Shared display formatting for the dashboard — durations, relative times, compact numbers.
// Space Mono everywhere in the UI means these stay plain text, no icon fonts.

export function formatMinutes(totalMs: number): string {
  const totalMinutes = Math.round(totalMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (hours < 24) return `${hours}h ${minutes}m`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return `${days}d ${remHours}h`;
}

export function formatCompactNumber(value: number): string {
  if (value < 1000) return String(value);
  if (value < 10000) return `${(value / 1000).toFixed(1)}K`;
  if (value < 1000000) return `${Math.round(value / 1000)}K`;
  return `${(value / 1000000).toFixed(1)}M`;
}

export function formatRelativeTime(date: Date, now: Date = new Date()): string {
  const diffMs = now.getTime() - date.getTime();
  const diffMinutes = Math.floor(diffMs / 60000);
  if (diffMinutes < 1) return 'now';
  if (diffMinutes < 60) return `${diffMinutes}m`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d`;
  const diffWeeks = Math.floor(diffDays / 7);
  return `${diffWeeks}w`;
}

// Signed delta for a stat tile — vs a named prior period. Null when there's nothing meaningful
// to compare against (e.g. the 'lifetime'/'all' windows have no equal-length "previous period").
export interface Delta {
  direction: 'up' | 'down' | 'flat';
  percent: number | null; // null when prev was 0 (percent change is undefined)
}

export function computeDelta(current: number, previous: number): Delta {
  if (current === previous) return { direction: 'flat', percent: previous === 0 ? null : 0 };
  const direction = current > previous ? 'up' : 'down';
  if (previous === 0) return { direction, percent: null };
  const percent = Math.round((Math.abs(current - previous) / previous) * 100);
  return { direction, percent };
}

export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
