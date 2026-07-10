import type { APIRoute } from 'astro';
import { createSupabaseServerClient, createSupabaseServiceClient } from '../../lib/supabase';
import { createWorkersAiProvider } from '../../lib/llm';
import { ASK_DAILY_LIMIT, bumpAskUsage, runAskAgent, type UsageState } from '../../lib/ask';

const MAX_QUESTION_LEN = 500;
const CAP_MESSAGE = "That's today's 50 questions — back tomorrow. 🌙";

// Ask a natural-language question about your own listening history. Same auth pattern as the other
// API routes: verify the session with the request-scoped client, then do the actual (RLS-bypassing)
// data work with the service-role client. The model only ever sees this profile's data — the
// profile_id is injected server-side in the agent, never taken from the request or the model.
export const POST: APIRoute = async ({ request, cookies, locals }) => {
  const env = locals.runtime.env;
  const supabase = createSupabaseServerClient(request, cookies, env);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return json({ error: 'unauthenticated' }, 401);

  const service = createSupabaseServiceClient(env);
  const { data: profile } = await service
    .from('spotify_profiles')
    .select('id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!profile) return json({ error: 'no_spotify_profile' }, 404);
  const profileId = (profile as { id: string }).id;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  const question = (body as { question?: unknown })?.question;
  if (typeof question !== 'string' || question.trim().length === 0) {
    return json({ error: 'empty_question' }, 400);
  }
  if (question.length > MAX_QUESTION_LEN) {
    return json({ error: 'question_too_long' }, 400);
  }

  // Charge the request against today's cap before doing any work; a blocked request isn't charged.
  // Fails open if the usage RPC isn't there yet (migration not pasted) so the feature still works —
  // the cap is a cost guardrail, not a correctness invariant.
  let usage: UsageState;
  try {
    usage = await bumpAskUsage(service, profileId);
  } catch (err) {
    console.error('ask usage check failed (ai_usage migration not applied?)', err);
    usage = { allowed: true, used: 0, remaining: ASK_DAILY_LIMIT };
  }
  if (!usage.allowed) {
    return json({ capped: true, remaining: 0, answer: CAP_MESSAGE, rich: null });
  }

  try {
    const llm = createWorkersAiProvider(env.AI);
    const { answer, rich } = await runAskAgent({ llm, service, profileId, question: question.trim() });
    return json({ answer, rich, remaining: usage.remaining });
  } catch (err) {
    console.error('ask agent failed', err);
    return json({ error: 'ask_failed', answer: "Something went wrong on my end — try that again in a moment." }, 500);
  }
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
