#!/usr/bin/env node
/**
 * connect-9router.js
 * ---------------------------------------------------------------------------
 * Registers the OpenCode free adapter inside 9Router as an OpenAI-compatible
 * provider node, and adds every working free model to it.
 *
 * Works against the local 9Router API on http://127.0.0.1:20128 by default.
 * Run `node connect-9router.js` after both the adapter and 9Router are up.
 *
 * Zero dependencies.
 */

import { workingModels } from "./opencode_free.js";

const ROUTER = process.env.ROUTER_URL || "http://127.0.0.1:20128";
const ADAPTER = process.env.ADAPTER_URL || "http://127.0.0.1:8790/v1";
const API_KEY = process.env.ADAPTER_API_KEY || "sk-opencode-free";
const NAME = process.env.PROVIDER_NAME || "OpenCode Free";

async function api(path, { method = "GET", body, token } = {}) {
  const res = await fetch(`${ROUTER}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

async function login() {
  const password = process.env.INITIAL_PASSWORD || "123456";
  for (const path of ["/api/auth/login", "/api/login"]) {
    const { status, json } = await api(path, { method: "POST", body: { password } });
    if (status < 400) {
      const token =
        json.token || json.access_token || json.data?.token || json.data?.access_token || null;
      if (token) return token;
    }
  }
  return null;
}

async function ensureProvider(token) {
  const body = {
    name: NAME,
    type: "openai-compatible",
    baseUrl: ADAPTER,
    apiKey: API_KEY,
    models: workingModels(),
  };
  for (const path of ["/api/provider-nodes", "/api/providers"]) {
    const { status, json } = await api(path, { method: "POST", body, token });
    if (status < 400) return json;
  }
  throw new Error("could not create provider node (check 9Router is running)");
}

async function main() {
  console.log(`9Router : ${ROUTER}`);
  console.log(`adapter : ${ADAPTER}`);

  // 1. adapter must be healthy
  try {
    const health = await fetch(`${ADAPTER.replace(/\/v1$/, "")}/health`);
    if (!health.ok) throw new Error(String(health.status));
  } catch (err) {
    console.error(`!! adapter not reachable at ${ADAPTER} (${err.message})`);
    console.error("   start it first:  node src/adapter.js");
    process.exit(1);
  }

  // 2. log into 9Router when it is password protected
  const token = await login();
  if (token) console.log("authenticated with 9Router");

  // 3. register the provider
  const created = await ensureProvider(token);
  console.log(`provider "${NAME}" registered as ${ADAPTER}`);
  console.log(`models (${workingModels().length}): ${workingModels().join(", ")}`);
  if (created?.id || created?.data?.id) console.log("provider id:", created.id || created.data.id);
  console.log("\nDone. In 9Router the free models are now routable.");
}

main().catch((err) => {
  console.error("connect failed:", err.message);
  process.exit(1);
});
