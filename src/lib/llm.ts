// LLM provider boundary. Everything that talks to a model goes through this module, so swapping
// Cloudflare Workers AI for the Anthropic API later means rewriting one file (createWorkersAiProvider
// → createAnthropicProvider) and adding one secret — no caller changes. The interface is deliberately
// minimal: system prompt + messages + tool schemas in, text-or-tool-calls out.
//
// Model: @cf/zai-org/glm-4.7-flash — Cloudflare's currently-recommended model for *fast* tool calling
// (see workers-ai/changelog), which is exactly this workload: a short agent loop (<=4 tool calls),
// request/response, no streaming. Alternatives, if this one is retired from the catalog or misbehaves
// on tool calls, are a one-line swap here: '@cf/meta/llama-4-scout-17b-16e-instruct' or the
// function-calling doc's canonical '@hf/nousresearch/hermes-2-pro-mistral-7b'.
export const WORKERS_AI_MODEL = '@cf/zai-org/glm-4.7-flash';

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

export interface LlmChatInput {
  system: string;
  messages: LlmMessage[];
  tools: LlmToolSchema[];
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
    // Native binding shape is { name, arguments }; the OpenAI-ish shape nests under `function`.
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
    async chat({ system, messages, tools }: LlmChatInput): Promise<LlmResponse> {
      const payload = {
        messages: [{ role: 'system', content: system }, ...messages],
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      };
      // The binding's typed input doesn't model arbitrary tool schemas per model, so cast at the
      // boundary; the response is likewise loosely typed and normalised below.
      const raw = (await (ai as { run: (m: string, i: unknown) => Promise<unknown> }).run(
        model,
        payload,
      )) as Record<string, unknown>;

      const toolCalls = normaliseToolCalls(raw.tool_calls);
      const text = typeof raw.response === 'string' && raw.response.trim() ? raw.response : null;
      return { text, toolCalls };
    },
  };
}
