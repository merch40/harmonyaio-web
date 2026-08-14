// POST /api/chat  -- the harmonyaio.com site assistant.
//
// Two providers, chosen at runtime so the prototype can be compared without a
// code change:
//   ANTHROPIC_API_KEY set  -> Claude. Better at holding a refusal under
//                             pressure, which is the whole game here.
//   otherwise              -> Workers AI (env.AI). No extra secret, free tier,
//                             good enough to demo.
// If neither is available the endpoint reports it rather than pretending.
//
// The knowledge boundary lives in chat_knowledge.js. This file is transport,
// validation, and the output guard.

import { buildSystemPrompt } from "./chat_knowledge.js";

// A public endpoint with an LLM behind it is a bill waiting to happen, so the
// shape of a request is capped before a single token is spent.
export const LIMITS = {
  maxMessages: 12,       // ~6 turns of back and forth
  maxCharsPerMessage: 800,
  maxTotalChars: 6000,
  maxOutputTokens: 400,
};

const REFUSAL = "That is not public yet.  The early access list on this page is where it gets announced first.";

const WORKERS_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const ANTHROPIC_MODEL = "claude-sonnet-4-6";

export async function handleChat(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body must be JSON" }, 400);
  }

  const messages = validateMessages(body?.messages);
  if (typeof messages === "string") {
    return json({ error: messages }, 400);
  }

  // Cloudflare's rate limiting binding, when configured. Keyed on the client
  // IP so one visitor cannot drain the day's budget for everyone else.
  if (env.CHAT_RATE_LIMIT) {
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const { success } = await env.CHAT_RATE_LIMIT.limit({ key: ip });
    if (!success) {
      return json({ error: "Too many messages.  Give it a minute." }, 429);
    }
  }

  const systemPrompt = buildSystemPrompt();

  try {
    const raw = env.ANTHROPIC_API_KEY
      ? await askAnthropic(env, messages, systemPrompt)
      : await askWorkersAI(env, messages, systemPrompt);
    return json({ reply: guardOutput(raw) });
  } catch (err) {
    if (err instanceof ChatError) {
      console.error("chat:", err.message);
      return json({ error: err.publicMessage }, err.status);
    }
    console.error("chat exception:", err);
    return json({ error: "The assistant is unavailable right now." }, 502);
  }
}

class ChatError extends Error {
  constructor(message, status, publicMessage) {
    super(message);
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

// validateMessages returns the cleaned array, or a string describing what is
// wrong with it. Roles are forced to user/assistant: a caller must not be able
// to smuggle in a second system message and overwrite the boundary.
export function validateMessages(input) {
  if (!Array.isArray(input) || input.length === 0) {
    return "messages must be a non-empty array";
  }
  if (input.length > LIMITS.maxMessages) {
    return `messages must contain at most ${LIMITS.maxMessages} entries`;
  }

  let total = 0;
  const cleaned = [];
  for (const m of input) {
    const role = m?.role === "assistant" ? "assistant" : "user";
    const content = typeof m?.content === "string" ? m.content.trim() : "";
    if (!content) {
      return "every message needs non-empty string content";
    }
    if (content.length > LIMITS.maxCharsPerMessage) {
      return `each message must be at most ${LIMITS.maxCharsPerMessage} characters`;
    }
    total += content.length;
    cleaned.push({ role, content });
  }
  if (total > LIMITS.maxTotalChars) {
    return `the conversation must be at most ${LIMITS.maxTotalChars} characters`;
  }
  if (cleaned[cleaned.length - 1].role !== "user") {
    return "the last message must be from the user";
  }
  return cleaned;
}

async function askWorkersAI(env, messages, systemPrompt) {
  if (!env.AI) {
    throw new ChatError(
      "neither ANTHROPIC_API_KEY nor the AI binding is configured",
      503,
      "The assistant is not configured yet."
    );
  }
  const result = await env.AI.run(WORKERS_AI_MODEL, {
    messages: [{ role: "system", content: systemPrompt }, ...messages],
    max_tokens: LIMITS.maxOutputTokens,
    temperature: 0.3,
  });
  const text = (result?.response || "").trim();
  if (!text) {
    throw new ChatError("workers ai returned an empty response", 502, "The assistant is unavailable right now.");
  }
  return text;
}

async function askAnthropic(env, messages, systemPrompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: env.ANTHROPIC_MODEL || ANTHROPIC_MODEL,
      max_tokens: LIMITS.maxOutputTokens,
      temperature: 0.3,
      system: systemPrompt,
      messages,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new ChatError(
      `anthropic returned ${res.status}: ${detail.slice(0, 300)}`,
      502,
      "The assistant is unavailable right now."
    );
  }
  const data = await res.json();
  const text = (data?.content || [])
    .filter((b) => b?.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!text) {
    throw new ChatError("anthropic returned no text content", 502, "The assistant is unavailable right now.");
  }
  return text;
}

// Phrases that only turn up when the model is reciting its own configuration
// or has been talked out of the boundary. Cheap to check, and the failure mode
// of a false positive is one flat refusal rather than a leak.
const LEAK_MARKERS = [
  "system prompt",
  "the facts block",
  "facts block",
  "my instructions",
  "refusal_topics",
  "you are the harmony aio assistant",
  "i was told to",
  "i have been instructed",
  "as an ai language model",
];

// guardOutput is the last gate before text reaches a visitor.
export function guardOutput(text) {
  const cleaned = normalisePunctuation(text);
  const lower = cleaned.toLowerCase();
  if (LEAK_MARKERS.some((marker) => lower.includes(marker))) {
    return REFUSAL;
  }
  return cleaned;
}

// The brand bans em dashes and en dashes outright, and a model will reach for
// one no matter how firmly the prompt says not to. Rewriting is more reliable
// than asking. A spaced dash becomes a sentence break, an unspaced one becomes
// a comma so hyphenated-looking constructions still read.
export function normalisePunctuation(text) {
  return text
    .replace(/\s+[—–]\s+/g, ".  ")
    .replace(/[—–]/g, ", ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
