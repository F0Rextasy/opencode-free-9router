#!/usr/bin/env node
/**
 * adapter.js
 * ---------------------------------------------------------------------------
 * OpenAI-compatible HTTP server that fronts the OpenCode Zen free models.
 *
 * Point 9Router (or any OpenAI client) at http://127.0.0.1:8790/v1 and it can
 * list and call every working free model without an OpenCode API key.
 *
 * Endpoints:
 *   GET  /v1/models
 *   POST /v1/chat/completions      (stream + non-stream)
 *   GET  /health
 *
 * Zero dependencies.
 */

import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { complete, workingModels, CHAT_MODELS, RESPONSES_MODELS } from "./opencode_free.js";

const PORT = Number(process.env.PORT || 8790);
const HOST = process.env.HOST || "127.0.0.1";
const API_KEY = process.env.ADAPTER_API_KEY || "";
const QUIET = process.env.QUIET === "1";

export function modelList() {
  const created = Math.floor(Date.now() / 1000);
  return workingModels().map((id) => ({
    id,
    object: "model",
    created,
    owned_by: "opencode",
  }));
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 20 * 1024 * 1024) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function authorized(req) {
  const keys = acceptedKeys();
  if (!keys.length) return true;
  const header = req.headers["authorization"] || "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  return presented ? keys.includes(presented) : false;
}

/**
 * Keys this adapter accepts.
 *
 * `ADAPTER_API_KEYS_FILE` (one key per line, `#` comments allowed) takes
 * precedence over the single `ADAPTER_API_KEY`, so a pool of locally issued keys
 * can share one adapter instead of one adapter per key.
 */
let keysCache = null;
function acceptedKeys() {
  if (keysCache) return keysCache;
  // `ADAPTER_API_KEYS_FILE` wins; otherwise fall back to the repo's own
  // outputs/keys.txt, so a locally generated pool is enforced without having to
  // thread the path through whatever shell started the adapter.
  const candidates = [];
  if (process.env.ADAPTER_API_KEYS_FILE) candidates.push(process.env.ADAPTER_API_KEYS_FILE);
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    candidates.push(join(here, "..", "outputs", "keys.txt"));
  } catch (e) {
    /* import.meta.url always exists in ESM; keep going if it somehow does not */
  }
  for (const file of candidates) {
    try {
      const keys = readFileSync(file, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));
      if (keys.length) {
        keysCache = keys;
        return keysCache;
      }
    } catch (e) {
      if (process.env.ADAPTER_API_KEYS_FILE === file) console.error(`ADAPTER_API_KEYS_FILE ${file}: ${e.message}`);
    }
  }
  keysCache = API_KEY ? [API_KEY] : [];
  return keysCache;
}

export function createServer() {
  return http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      });
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "GET" && (path === "/health" || path === "/")) {
      json(res, 200, { status: "ok", models: workingModels().length });
      return;
    }

    if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
      json(res, 200, { object: "list", data: modelList() });
      return;
    }

    if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
      if (!authorized(req)) {
        json(res, 401, { error: { message: "invalid api key", type: "invalid_request_error" } });
        return;
      }
      let body;
      try {
        body = JSON.parse((await readBody(req)) || "{}");
      } catch {
        json(res, 400, { error: { message: "invalid JSON body", type: "invalid_request_error" } });
        return;
      }
      const model = body.model;
      if (!model) {
        json(res, 400, { error: { message: "model is required", type: "invalid_request_error" } });
        return;
      }
      try {
        const result = await complete(model, body, {
          downstreamUa: req.headers["user-agent"] || "",
          downstreamClient: req.headers["x-opencode-client"] || "",
          project: req.headers["x-opencode-project"] || "global",
        });
        if (body.stream) {
          streamAsSse(res, result, model);
        } else {
          json(res, 200, result);
        }
      } catch (err) {
        if (!QUIET) console.error(`[adapter] ${model} -> ${err.message}`);
        json(res, err.status && err.status >= 400 ? err.status : 502, {
          error: { message: err.message, type: "upstream_error" },
        });
      }
      return;
    }

    json(res, 404, { error: { message: `no route for ${req.method} ${path}`, type: "invalid_request_error" } });
  });
}

/** Re-emit an aggregated completion as an SSE stream for streaming clients. */
function streamAsSse(res, completion, model) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  const id = completion.id;
  const created = completion.created;
  const content = completion.choices?.[0]?.message?.content || "";
  const head = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
  };
  res.write(`data: ${JSON.stringify(head)}\n\n`);
  for (const piece of chunkText(content, 48)) {
    const chunk = {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  const tail = {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };
  res.write(`data: ${JSON.stringify(tail)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

function chunkText(text, size) {
  if (!text) return [""];
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

// `file://${process.argv[1]}` never matches on Windows (backslashes, drive
// letter), so the server silently exited instead of listening; compare real URLs.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`opencode-free adapter listening on http://${HOST}:${PORT}/v1`);
    console.log(`  chat models:      ${CHAT_MODELS.length}`);
    console.log(`  responses models: ${RESPONSES_MODELS.length}`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
