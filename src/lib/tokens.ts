import { createSupabaseServiceClient } from './supabase';
import { decryptToken, encryptToken } from './crypto';
import { refreshAccessToken } from './spotify';

// Server-side only: reads the encrypted refresh token, exchanges it for a fresh access token,
// and re-encrypts + persists the refresh token if Spotify rotated it. Never expose this to the client.
export async function getValidSpotifyAccessToken(
  userId: string,
  env: Pick<Env, 'PUBLIC_SUPABASE_URL' | 'SUPABASE_SERVICE_ROLE_KEY' | 'SPOTIFY_CLIENT_ID' | 'TOKEN_ENC_KEY'>,
): Promise<{ accessToken: string; spotifyUserId: string } | null> {
  const supabase = createSupabaseServiceClient(env);

  const { data: profile, error } = await supabase
    .from('spotify_profiles')
    .select('spotify_user_id, refresh_token_enc')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  if (!profile) return null;

  const refreshToken = await decryptToken(profile.refresh_token_enc, env.TOKEN_ENC_KEY);
  const tokens = await refreshAccessToken({ clientId: env.SPOTIFY_CLIENT_ID, refreshToken });

  const update: { last_synced_at: string; refresh_token_enc?: string } = {
    last_synced_at: new Date().toISOString(),
  };
  if (tokens.refresh_token) {
    update.refresh_token_enc = await encryptToken(tokens.refresh_token, env.TOKEN_ENC_KEY);
  }

  const { error: updateError } = await supabase
    .from('spotify_profiles')
    .update(update)
    .eq('user_id', userId);
  if (updateError) throw updateError;

  return { accessToken: tokens.access_token, spotifyUserId: profile.spotify_user_id };
}
