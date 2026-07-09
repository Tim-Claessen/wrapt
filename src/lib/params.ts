// Shared URL query-param decoding for the dashboard (index) and history pages, so the two agree on
// since/until/page/window/kind. Date parsing is hardened: a param that doesn't parse to a valid Date
// is treated as absent, so a garbage `?since=foo` degrades to the default window/filter instead of
// producing an Invalid Date that later throws when we call `.toISOString()`.

// A yyyy-mm-dd `since` param, read as the start of that day. Blank/invalid → null.
export function parseSinceParam(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return isNaN(date.getTime()) ? null : date;
}

// A yyyy-mm-dd `until` param, read as the end of that day (23:59:59). Blank/invalid → null.
export function parseUntilParam(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(`${value}T23:59:59`);
  return isNaN(date.getTime()) ? null : date;
}

// 1-based page number; non-numeric, non-finite, or < 1 → 1.
export function parsePageParam(value: string | null): number {
  const n = Number(value ?? '1');
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

// Return `value` when it's one of `allowed`, otherwise `fallback`. Used for the window/kind params.
export function parseEnumParam<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}
