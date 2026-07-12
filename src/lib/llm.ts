// LLM provider boundary. Everything that talks to a model goes through this module, so swapping
// Cloudflare Workers AI for the Anthropic API later means rewriting one file (createWorkersAiProvider
// → createAnthropicProvider) and adding one secret — no caller changes. The interface is deliberately
// minimal: system prompt + messages + tool schemas in, text-or-tool-calls out.
//
// Model: @cf/meta/llama-4-scout-17b-16e-instruct — current Llama 4, verified against the live binding
// to emit clean tool calls and synthesise grounded answers for this workload (short agent loop,
// <=4 tool calls, request/response, no streaming). Swapping is a one-line change here; note the
// binding rejected @cf/zai-org/glm-4.7-flash on tool calls in testing (504s), so re-verify any swap.
export const WORKERS_AI_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';

// The Workers AI binding, typed off the generated Env so we don't depend on the global `Ai` name.
type AiBinding = Env['AI'];

export interface LlmToolSchema {
  name: string;
  description: string;
  // JSON-Schema object describing the tool's params — passed to the model verbatim.
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface LlmToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

// A message in the running conversation. `tool` messages carry a tool's JSON result back to the
// model; assistant messages that requested tools carry the raw tool-call payload as `content`.
export interface LlmMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
}

export interface LlmResponse {
  text: string | null;
  toolCalls: LlmToolCall[];
}

// Cloudflare's implicit default completion length for this model is short (observed: truncates well
// under 300 tokens with no max_tokens set) — nowhere near enough for a multi-item JSON payload like
// the Playlist draft's ~28 tracks. A truncated response is invalid JSON, which callers then parse as
// an empty result with no visible error (see src/lib/playlist.ts). Always set an explicit max_tokens
// so a long, valid completion isn't silently cut short; callers needing more than the default can
// override per-call.
const DEFAULT_MAX_TOKENS = 1024;

export interface LlmChatInput {
  system: string;
  messages: LlmMessage[];
  tools: LlmToolSchema[];
  maxTokens?: number;
}

export interface LlmProvider {
  readonly model: string;
  chat(input: LlmChatInput): Promise<LlmResponse>;
}

// Models return tool arguments as either a parsed object or a JSON string — normalise to an object,
// tolerating junk (an unparseable string becomes {} and fails validation downstream, which is the
// right outcome: we never trust model output).
function normaliseArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

function normaliseToolCalls(raw: unknown): LlmToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: LlmToolCall[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    // Llama-4-scout returns { id, type:'function', function:{ name, arguments:"<json string>" } };
    // older/native shapes are a flat { name, arguments }. Handle both.
    const e = entry as Record<string, unknown>;
    const fn = (e.function as Record<string, unknown> | undefined) ?? e;
    const name = fn.name;
    if (typeof name !== 'string' || !name) continue;
    calls.push({ name, arguments: normaliseArguments(fn.arguments) });
  }
  return calls;
}

export function createWorkersAiProvider(ai: AiBinding, model: string = WORKERS_AI_MODEL): LlmProvider {
  return {
    model,
    async chat({ system, messages, tools, maxTokens }: LlmChatInput): Promise<LlmResponse> {
      const payload: Record<string, unknown> = {
        messages: [{ role: 'system', content: system }, ...messages],
        max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
      };
      // OpenAI-style tool schema — the live binding rejects the flat { name, parameters } form with
      // "8001: Invalid input". Omit `tools` entirely when there are none (the loop drops them to
      // force a final text answer) so we never send an empty array.
      if (tools.length > 0) {
        payload.tools = tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
      }
      // The binding's typed input doesn't model arbitrary tool schemas per model, so cast at the
      // boundary; the response is likewise loosely typed and normalised below.
      const raw = (await (ai as { run: (m: string, i: unknown) => Promise<unknown> }).run(
        model,
        payload,
      )) as Record<string, unknown>;

      // Tool calls / text can arrive either top-level ({ tool_calls, response }) or OpenAI-nested
      // ({ choices: [{ message: { tool_calls, content } }] }) — accept both.
      const choiceMsg = (raw.choices as { message?: Record<string, unknown> }[] | undefined)?.[0]?.message;
      const toolCalls = normaliseToolCalls(raw.tool_calls ?? choiceMsg?.tool_calls);
      const rawText = (typeof raw.response === 'string' ? raw.response : undefined) ??
        (typeof choiceMsg?.content === 'string' ? (choiceMsg.content as string) : undefined);
      const text = rawText && rawText.trim() ? rawText : null;
      return { text, toolCalls };
    },
  };
}
