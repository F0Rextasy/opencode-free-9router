/**
 * opencode_free.js
 * ---------------------------------------------------------------------------
 * Client for the OpenCode Zen "free tier" gateway (https://opencode.ai/zen).
 *
 * The free models are gated upstream by an attestation that only passes when
 * the request looks like it came from the official OpenCode client. This module
 * reproduces that fingerprint:
 *
 *   - User-Agent:        opencode/<version>            (version >= 1.17)
 *   - x-opencode-client: desktop
 *   - x-opencode-session: ses_<12 hex><14 base62>      (stable per identity)
 *   - x-opencode-request: msg_<12 hex><14 base62>      (stable per turn)
 *   - Authorization:     Bearer public
 *   - stream: true                                     (non-streaming 403s)
 *   - tools:             bash, glob, grep, read         (fingerprint quartet)
 *
 * Without those a free model answers 403 FreeTierError: "OpenCode's free tier
 * can only be used from within OpenCode".
 *
 * Zero dependencies. Node >= 18 (global fetch + Web streams).
 */

import crypto from "node:crypto";

export const ZEN_BASE = "https://opencode.ai/zen/v1";

/** Models served by /chat/completions and verified reachable. */
export const CHAT_MODELS = [
  "big-pickle",
  "longcat-2.5-preview-free",
  "mimo-v2.6-flash-free",
  "nemotron-3-ultra-free",
  "nemotron-3.5-lightning-free",
];

/** Models served by the OpenAI Responses API (/responses). */
export const RESPONSES_MODELS = [];

/** Models known to the gateway but not currently serving requests. */
export const DEGRADED_MODELS = [
  "exo-free",
  "ling-3.0-flash-fin-free",
  "fledge-alpha-free", // live check 2026-10-23: 410 deprecated
  "muse-spark-1.2-contributor-free", // 410 deprecated
  "muse-spark-1.3-contributor-free", // 410 deprecated
  "ling-3.1-flash-free", // 400 model unavailable
  "space-bunny-free", // 400 model unavailable
  "step-5-preview-free", // 400 model unavailable
];

/**
 * Models on a non-OpenAI protocol (SystemOne). Documented but not proxied
 * because the wire format differs; 9Router handles them natively.
 */
export const EXOTIC_MODELS = ["jev-1.13-free"];

export const ALL_MODELS = [...CHAT_MODELS, ...RESPONSES_MODELS, ...DEGRADED_MODELS];

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const OPENCODE_VERSION = "1.18.31";
export const SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
export const REQUEST_RE = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

/** The tool names the upstream fingerprint check expects to see declared. */
const FINGERPRINT_TOOLS = ["bash", "glob", "grep", "read"];

function randomBase62(length) {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += BASE62[bytes[i] % 62];
  return out;
}

function hexPrefix(prefix, timestamp, invert) {
  let value = BigInt(timestamp) * 0x1000n + 1n;
  if (invert) value = ~value & 0xffffffffffffn;
  let hex = "";
  for (let i = 0; i < 6; i++) {
    hex += Number((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, "0");
  }
  return `${prefix}_${hex}`;
}

/** Mint a fresh, structurally valid OpenCode session id. */
export function newSessionId(timestamp = Date.now()) {
  return `${hexPrefix("ses", timestamp, true)}${randomBase62(14)}`;
}

/** Mint a fresh, structurally valid OpenCode request id. */
export function newRequestId(timestamp = Date.now()) {
  return `${hexPrefix("msg", timestamp, false)}${randomBase62(14)}`;
}

/**
 * Derive a stable session id from a downstream identity so free-tier quota is
 * accounted per conversation, not per request (the real CLI reuses one session).
 */
const stableSessions = new Map();
const MAX_STABLE = 1000;

export function stableSessionId(identity = "default") {
  const key = String(identity).slice(0, 128) || "default";
  const existing = stableSessions.get(key);
  if (existing) {
    stableSessions.delete(key);
    stableSessions.set(key, existing);
    return existing;
  }
  const session = newSessionId();
  if (stableSessions.size >= MAX_STABLE) {
    stableSessions.delete(stableSessions.keys().next().value);
  }
  stableSessions.set(key, session);
  return session;
}

/** Derive a deterministic request id from session + last user turn. */
export function deriveRequestId(sessionId, body) {
  const text = lastUserText(body);
  if (!text) return newRequestId();
  const digest = crypto
    .createHash("sha256")
    .update(`opencode-req\0${sessionId || ""}\0${text}`)
    .digest();
  let hex = digest.subarray(0, 6).toString("hex");
  let rest = "";
  for (let i = 6; i < 20; i++) rest += BASE62[digest[i] % 62];
  const id = `msg_${hex}${rest}`;
  return REQUEST_RE.test(id) ? id : newRequestId();
}

function lastUserText(body) {
  const arr = Array.isArray(body?.messages)
    ? body.messages
    : Array.isArray(body?.input)
      ? body.input
      : null;
  if (!arr) return typeof body?.input === "string" ? body.input.slice(-600) : "";
  for (let i = arr.length - 1; i >= 0; i--) {
    const msg = arr[i];
    if (!msg || (msg.role && msg.role !== "user")) continue;
    const content = msg.content;
    if (typeof content === "string" && content.trim()) return content.trim().slice(-600);
    if (Array.isArray(content)) {
      const text = content
        .map((p) => (typeof p === "string" ? p : p?.text || p?.input_text || ""))
        .join(" ")
        .trim();
      if (text) return text.slice(-600);
    }
  }
  return "";
}

function toolName(tool) {
  if (!tool || typeof tool !== "object") return "";
  const fn = tool.function && typeof tool.function === "object" ? tool.function : null;
  return (typeof tool.name === "string" ? tool.name : fn?.name || "").trim();
}

function ensureFingerprintTools(body, responsesShape) {
  const present = new Set(Array.isArray(body.tools) ? body.tools.map(toolName) : []);
  if (!Array.isArray(body.tools)) body.tools = [];
  for (const name of FINGERPRINT_TOOLS) {
    if (present.has(name)) continue;
    body.tools.push(
      responsesShape
        ? {
            type: "function",
            name,
            description: `OpenCode built-in ${name} tool`,
            parameters: { type: "object", properties: {} },
          }
        : {
            type: "function",
            function: {
              name,
              description: `OpenCode built-in ${name} tool`,
              parameters: { type: "object", properties: {} },
            },
          },
    );
    present.add(name);
  }
}

function hasValidVersion(ua) {
  const m = String(ua || "").match(/opencode\/(\d+)\.(\d+)(?:\.(\d+))?/i);
  if (!m) return false;
  const major = +m[1];
  const minor = +m[2];
  return major > 1 || (major === 1 && minor >= 17);
}

export function isResponsesModel(model) {
  const base = String(model || "").replace(/\([^()]+\)\s*$/, "").trim();
  return RESPONSES_MODELS.includes(base);
}

/**
 * Map a downstream bearer to the upstream Authorization header.
 *
 * Console service-account keys (`oc_sk_...`) are forwarded verbatim so requests
 * are attributed to the account that owns them; anything else (the adapter's own
 * `sk-ocfree-...` keys, an empty header) uses the anonymous `Bearer public`
 * rail the free tier already accepts.
 */
export function upstreamAuthorization(key) {
  const value = String(key || "").trim();
  return /^oc_sk_[A-Za-z0-9_-]{16,}$/.test(value) ? `Bearer ${value}` : "Bearer public";
}

/** Build the attested headers for one upstream call. */
export function buildHeaders({
  model,
  body,
  downstreamUa = "",
  downstreamClient = "",
  project = "global",
  stream = true,
  authorization = "Bearer public",
} = {}) {
  const session = stableSessionId("opencode-free");
  const requestId = deriveRequestId(session, body);
  return {
    "Content-Type": "application/json",
    Authorization: authorization,
    "User-Agent": hasValidVersion(downstreamUa) ? downstreamUa : `opencode/${OPENCODE_VERSION}`,
    "x-opencode-client": downstreamClient || "desktop",
    "x-opencode-session": session,
    "x-opencode-request": requestId,
    "x-opencode-project": project,
    Accept: stream ? "text/event-stream" : "*/*",
  };
}

/**
 * Normalise an OpenAI Chat Completions body for the free gateway.
 * Returns a serialisable body with the fingerprint applied.
 */
export function prepareChatBody(model, body) {
  const out = { ...body, model, stream: true };
  if (!Array.isArray(out.messages)) out.messages = [];
  ensureFingerprintTools(out, false);
  return out;
}

/**
 * Normalise a Chat Completions body into the OpenAI Responses shape used by
 * the muse-spark contributor models.
 */
export function prepareResponsesBody(model, body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const input = messages.map((m) => ({
    type: "message",
    role: m.role,
    content: [
      {
        type: m.role === "assistant" ? "output_text" : "input_text",
        text: typeof m.content === "string" ? m.content : extractText(m.content),
      },
    ],
  }));
  if (input.length === 0) {
    input.push({ type: "message", role: "user", content: [{ type: "input_text", text: "..." }] });
  }
  const out = {
    model,
    input,
    stream: true,
    store: false,
    max_output_tokens: body.max_tokens ?? body.max_completion_tokens ?? 4096,
  };
  if (body.reasoning_effort) out.reasoning = { effort: body.reasoning_effort, summary: "auto" };
  ensureFingerprintTools(out, true);
  return out;
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === "string" ? p : p?.text || p?.input_text || "")).join(" ");
  }
  return "";
}

/** Pick the upstream URL for a model. */
export function endpointFor(model) {
  if (isResponsesModel(model)) return `${ZEN_BASE}/responses`;
  return `${ZEN_BASE}/chat/completions`;
}

/** List models by asking the gateway (no attestation needed for this route). */
export async function listModels({ fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${ZEN_BASE}/models`, {
    headers: { Authorization: "Bearer public" },
  });
  if (!res.ok) throw new Error(`zen /models -> HTTP ${res.status}`);
  const json = await res.json();
  return (json.data || []).map((m) => m.id);
}

/** Return the locally-known working free model ids. */
export function workingModels() {
  return [...CHAT_MODELS, ...RESPONSES_MODELS];
}

/**
 * One non-streaming completion against a free model. Streams upstream (required)
 * and aggregates the SSE into a normal Chat Completion object.
 *
 * @returns {Promise<object>} an OpenAI-shaped chat completion
 */
export async function complete(model, body, opts = {}) {
  const { fetchImpl = fetch, timeoutMs = 120_000 } = opts;
  const responses = isResponsesModel(model);
  const prepared = responses ? prepareResponsesBody(model, body) : prepareChatBody(model, body);
  const headers = buildHeaders({
    model,
    body,
    downstreamUa: opts.downstreamUa,
    downstreamClient: opts.downstreamClient,
    project: opts.project,
    stream: true,
    authorization: upstreamAuthorization(opts.upstreamKey),
  });

  const controller = new AbortController();
  // The deadline has to stay armed while the body is read. Clearing it as soon as
  // the response headers arrive (the old shape) left `res.text()` with no bound at
  // all: a gateway that answers 200 and then stalls pinned this call, the socket and
  // the downstream request forever.
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(endpointFor(model), {
      method: "POST",
      headers,
      body: JSON.stringify(prepared),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      let detail = text;
      try {
        detail = JSON.parse(text).error?.message || text;
      } catch {
        /* keep raw */
      }
      const err = new Error(`opencode free: HTTP ${res.status} ${detail}`.trim());
      err.status = res.status;
      throw err;
    }

    if (responses) return await aggregateResponses(model, res);
    return await aggregateChat(model, res);
  } catch (err) {
    if (err?.name === "AbortError") {
      const timeout = new Error(`opencode free: upstream timeout after ${timeoutMs} ms`);
      timeout.status = 504;
      throw timeout;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** An upstream body that cannot be read as a stream is an error, not an empty answer. */
function streamFailure(model, detail) {
  const message = String(detail ?? "no content").replace(/\s+/g, " ").trim().slice(0, 300);
  const err = new Error(`opencode free: ${model} stream error: ${message || "no content"}`);
  err.status = 502;
  return err;
}

/** Pull a human-readable reason out of a body that was not a stream at all. */
function bodyReason(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed);
    const reason = parsed?.error?.message || parsed?.message || parsed?.error;
    if (reason) return typeof reason === "string" ? reason : JSON.stringify(reason);
  } catch {
    /* not JSON */
  }
  return trimmed.slice(0, 200);
}

async function aggregateChat(model, res) {
  const text = await res.text();
  let content = "";
  let reasoning = "";
  let finish = "stop";
  let usage = null;
  // The upstream streams tool calls as `delta.tool_calls`, split across chunks and keyed by
  // `index` (OpenAI's streaming contract). This aggregator collected only `content`/`reasoning`,
  // so every tool call was dropped while `finish_reason:"tool_calls"` survived — a caller saw a
  // completed call with nothing to execute and each agentic subagent stalled (measured on
  // space-bunny-free and big-pickle). Accumulate and merge them by index.
  const toolCalls = [];
  let chunks = 0;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue;
    }
    chunks++;
    // The free tier reports "free usage exceeded" as a JSON body or an SSE `error`
    // payload with HTTP 200. Folding that into an empty completion handed the caller
    // a successful stop with no content, and 9Router recorded a working model.
    if (chunk.error) throw streamFailure(model, chunk.error.message || chunk.error);
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finish = choice.finish_reason;
    const delta = choice.delta || {};
    content += delta.content || "";
    reasoning += delta.reasoning || "";
    if (Array.isArray(delta.tool_calls)) {
      for (const piece of delta.tool_calls) {
        const idx = Number.isInteger(piece.index) ? piece.index : toolCalls.length;
        if (!toolCalls[idx]) toolCalls[idx] = { id: piece.id || `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`, type: "function", function: { name: "", arguments: "" } };
        if (piece.id) toolCalls[idx].id = piece.id;
        if (piece.type) toolCalls[idx].type = piece.type;
        if (piece.function?.name) toolCalls[idx].function.name += piece.function.name;
        if (piece.function?.arguments) toolCalls[idx].function.arguments += piece.function.arguments;
      }
    }
  }
  if (!chunks) throw streamFailure(model, bodyReason(text) || "upstream returned 200 without a stream body");
  return {
    id: `chatcmpl-${crypto.randomUUID().replace(/-/g, "")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content || reasoning || "",
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finish,
      },
    ],
    usage: usage || undefined,
  };
}

async function aggregateResponses(model, res) {
  const text = await res.text();
  let content = "";
  let events = 0;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let ev;
    try {
      ev = JSON.parse(payload);
    } catch {
      continue;
    }
    events++;
    if (ev.type === "error" || ev.type === "response.failed") {
      throw streamFailure(model, ev.error?.message || ev.response?.error?.message || ev.type);
    }
    if (ev.type === "response.output_text.delta" && typeof ev.delta === "string") {
      content += ev.delta;
    } else if (ev.type === "response.completed" && ev.response?.output) {
      for (const item of ev.response.output) {
        for (const part of item.content || []) {
          if (part.type === "output_text" && part.text) content ||= part.text;
        }
      }
    }
  }
  if (!events) throw streamFailure(model, bodyReason(text) || "upstream returned 200 without a stream body");
  return {
    id: `chatcmpl-${crypto.randomUUID().replace(/-/g, "")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      { index: 0, message: { role: "assistant", content: content || "" }, finish_reason: "stop" },
    ],
  };
}
