import type { SupabaseClient } from '@supabase/supabase-js';
import { DISPLAY_TIME_ZONE } from './format';

// Generic per-profile, per-day, per-kind usage cap on top of the ai_usage table / bump_ai_usage RPC
// (supabase/migrations/20260710000000_ask_feature.sql). Shared by every AI feature that needs a daily
// cost guardrail (Ask, Playlist, ...) so the increment/read/fail-open behaviour lives in one place.

export interface UsageState {
  allowed: boolean;
  used: number;
  remaining: number;
}

// Atomically count this request against today's cap. Call once per accepted request, before the
// paid work runs; a blocked request is not charged (see bump_ai_usage).
export async function bumpUsage(
  service: SupabaseClient,
  profileId: string,
  kind: string,
  limit: number,
): Promise<UsageState> {
  const { data, error } = await service.rpc('bump_ai_usage', {
    p_profile_id: profileId,
    p_kind: kind,
    p_limit: limit,
  });
  if (error) throw error;
  const row = (data?.[0] ?? {}) as { allowed?: boolean; used?: number; remaining?: number };
  return {
    allowed: Boolean(row.allowed),
    used: Number(row.used ?? 0),
    remaining: Number(row.remaining ?? 0),
  };
}

// Read-only remaining count for today (no increment) — for quiet counters on /settings and composer
// hints. Fails open (assumes a full allowance) rather than throwing, so a not-yet-pasted `ai_usage`
// table can't 500 the pages that display it — this is a display concern, not enforcement.
export async function getUsageRemaining(
  service: SupabaseClient,
  profileId: string,
  kind: string,
  limit: number,
): Promise<{ used: number; remaining: number; limit: number }> {
  const day = new Date().toLocaleDateString('en-CA', { timeZone: DISPLAY_TIME_ZONE }); // YYYY-MM-DD, AWST
  try {
    const { data, error } = await service
      .from('ai_usage')
      .select('count')
      .eq('profile_id', profileId)
      .eq('day', day)
      .eq('kind', kind)
      .maybeSingle();
    if (error) throw error;
    const used = Number((data as { count?: number } | null)?.count ?? 0);
    return { used, remaining: Math.max(limit - used, 0), limit };
  } catch {
    return { used: 0, remaining: limit, limit };
  }
}

// Zero out today's counter for (profile, kind) — an escape hatch for /settings so a spent daily cap
// doesn't have to wait for AWST midnight. Deletes rather than updates: no row for today is exactly
// the same "0 used" state bump_ai_usage's INSERT path already handles.
export async function resetUsage(service: SupabaseClient, profileId: string, kind: string): Promise<void> {
  const day = new Date().toLocaleDateString('en-CA', { timeZone: DISPLAY_TIME_ZONE }); // YYYY-MM-DD, AWST
  const { error } = await service.from('ai_usage').delete().eq('profile_id', profileId).eq('day', day).eq('kind', kind);
  if (error) throw error;
}
