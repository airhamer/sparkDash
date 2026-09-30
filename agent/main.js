/**
 * sparkdash-node-agent — entry point.
 *
 * Runs on each DGX Spark (and Narthex). Provides local telemetry, live
 * versions, service catalog, memory budgeting, and actions over a local HTTP
 * API (default port 30091, next to the hasso5703 cockpit's 30090).
 *
 * Batches landed so far:
 *   - Batch 1A: agent/collectors/ + agent/telemetry.js + agent/http.js — LANDED
 *   - Batch 1B: agent/catalog/ (recipes.js, memory.js, services.js) — LANDED
 *   - Batch 2A: agent/actions/docker.js + agent/actions/audit.js
 *   - Batch 2B: agent/actions/systemd.js + agent/actions/llm-switch.js
 *   - Batch 2C: agent/actions/dispatch.js + http.js POST /actions + GET /audit,
 *     snapshot enrichment (services/memory/requests), LLM probe auth tokens
 *   - Batch 5A: agent/catalog/media.js
 *
 * Style: Node.js ESM, plain JS (JSDoc types), no build step. Mirrors sparkDash
 * server/ style. Reads the seam contract in shared/types.ts (JSDoc references).
 *
 * Env vars:
 *   NODE_AGENT_PORT   — HTTP port (default 30091)
 *   NODE_AGENT_BIND   — bind address (default 0.0.0.0)
 *   NODE_AGENT_TOKEN  — optional bearer token for the local HTTP API
 *   NODE_ID           — node id (default: hostname, "unknown" when unset)
 *   NODE_NAME         — node name (default: hostname, "unknown" when unset)
 *   NODE_LAN_IP       — node LAN IP (default: first non-loopback IPv4)
 *   LLM_PORTS         — comma-separated LLM server ports to probe (default "8080")
 *   NODE_COMFY_PORT   — ComfyUI port (default 8188; 0 = no ComfyUI probe)
 *   LLM_AUTH_TOKENS   — "port:token,port:token" bearer tokens for LLM servers
 *                       that gate their info endpoints behind an api-key
 *                       (sglang --api-key, vllm --api-key); empty = no auth
 *   NODE_AGENT_AUDIT_PATH — audit log path (default: <agent>/config/audit.log,
 *                       inside the mounted config volume)
 *   RECIPES_PATH      — path to recipes.json (default: <agent>/config/recipes.json,
 *                       fallback to <agent>/config/recipes.example.json when the
 *                       default is missing; an explicitly set RECIPES_PATH that
 *                       is missing degrades to an empty catalog, not the example)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadRecipes,
  getRecipe,
  listRecipes,
  validateRecipe,
  validateRecipeFile,
} from "./catalog/recipes.js";
import { computeMemoryBudget } from "./catalog/memory.js";
import { listServices } from "./catalog/services.js";
import { createHttpServer } from "./http.js";
import { collectTelemetry, AGENT_VERSION } from "./telemetry.js";
import { parseLlmAuthTokens } from "./collectors/llm.js";

// Catalog seam — re-exported so Worker 1A (telemetry) and 2A/2B (actions) can
// import from agent/main.js or the catalog modules directly (same code).
export { loadRecipes, getRecipe, listRecipes, validateRecipe, validateRecipeFile };
export { computeMemoryBudget };
export { listServices };
export { parseLlmAuthTokens };

const AGENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_RECIPES = path.join(AGENT_DIR, "config", "recipes.json");
const EXAMPLE_RECIPES = path.join(AGENT_DIR, "config", "recipes.example.json");

// AGENT_VERSION is defined in telemetry.js (single source of truth; the
// snapshot and the HTTP identity both report it).
export { AGENT_VERSION };

/**
 * Parse a comma-separated port list into unique valid port numbers.
 * @param {string | number | Array<string | number> | null | undefined} raw
 * @returns {number[]}
 */
export function parsePortList(raw) {
  if (raw == null) return [];
  const items = Array.isArray(raw)
    ? raw.map(String)
    : String(raw).split(",").map((s) => s.trim()).filter(Boolean);
  const seen = new Set();
  /** @type {number[]} */
  const out = [];
  for (const item of items) {
    const n = Number(String(item).trim());
    if (Number.isInteger(n) && n >= 1 && n <= 65535 && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

/**
 * First non-loopback IPv4 address, or "127.0.0.1" when none.
 * @returns {string}
 */
export function detectLanIp() {
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const item of list || []) {
        if (item.family === "IPv4" && !item.internal) return item.address;
      }
    }
  } catch {
    /* fall through */
  }
  return "127.0.0.1";
}

/**
 * Build the node identity from env vars.
 * @param {object} [env]
 * @returns {{nodeId: string, nodeName: string, lanIp: string, port: number, bind: string, token: string|null, llmPorts: number[], comfyPort: number|null, llmAuthTokens: Record<string, string>, auditPath: string}}
 */
export function readNodeIdentity(env = process.env) {
  const hostname = env.HOSTNAME || "unknown";
  const comfyPort = parsePortList(env.NODE_COMFY_PORT || "8188");
  return {
    nodeId: env.NODE_ID || hostname,
    nodeName: env.NODE_NAME || hostname,
    lanIp: env.NODE_LAN_IP || detectLanIp(),
    port: Number(env.NODE_AGENT_PORT || 30091),
    bind: env.NODE_AGENT_BIND || "0.0.0.0",
    token: env.NODE_AGENT_TOKEN || null,
    llmPorts: parsePortList(env.LLM_PORTS || "8080"),
    comfyPort: comfyPort.length > 0 ? comfyPort[0] : null,
    // "8080:<token>,8000:<token>" — per-port bearer tokens for LLM servers
    // that gate their info endpoints behind an api-key (empty → {}).
    llmAuthTokens: parseLlmAuthTokens(env.LLM_AUTH_TOKENS),
    auditPath: env.NODE_AGENT_AUDIT_PATH || "",
  };
}

/**
 * Resolve the recipes file path.
 * - env.RECIPES_PATH set → use as-is (a missing explicit path is surfaced to
 *   the caller, never papered over with the example).
 * - otherwise <agent>/config/recipes.json; if that is missing, fall back to
 *   <agent>/config/recipes.example.json so the agent works out of the box.
 * @param {object} [env]
 * @returns {string}
 */
export function resolveRecipesPath(env = process.env) {
  if (env.RECIPES_PATH) return env.RECIPES_PATH;
  try {
    fs.accessSync(DEFAULT_RECIPES);
    return DEFAULT_RECIPES;
  } catch {
    if (fs.existsSync(EXAMPLE_RECIPES)) return EXAMPLE_RECIPES;
    return DEFAULT_RECIPES; // let the caller surface the ENOENT
  }
}

// ── Catalog lifecycle (memoized) ────────────────────────────────────────────

let _catalog = null;

/**
 * Load (and memoize) the recipe catalog for this node.
 *
 * Graceful degradation (mirrors SparkRegistry's ENOENT → empty list):
 * an unreadable / schema-invalid recipes file logs a warning and yields an
 * empty catalog — the agent still boots, telemetry still flows, and catalog
 * endpoints report [] rather than 500.
 *
 * @param {object} [env]
 * @param {{force?: boolean}} [opts] force=true reloads from disk
 * @returns {{path: string, recipeFile: import("./catalog/recipes.js").RecipeFile, recipes: import("./catalog/recipes.js").Recipe[]}}
 */
export function loadCatalog(env = process.env, { force = false } = {}) {
  if (_catalog && !force) return _catalog;
  const identity = readNodeIdentity(env);
  const p = resolveRecipesPath(env);
  let recipeFile;
  try {
    recipeFile = loadRecipes(p);
  } catch (err) {
    console.warn(
      `[node-agent] recipes unavailable at ${p} (${err.message}); continuing with empty catalog`
    );
    recipeFile = { version: 1, nodeId: identity.nodeId, recipes: [] };
  }
  _catalog = { path: p, recipeFile, recipes: recipeFile.recipes };
  return _catalog;
}

/** Clear the memoized catalog (tests / future reload-on-file-change). */
export function resetCatalog() {
  _catalog = null;
}

// ── Snapshot enrichment (catalog join) ────────────────────────────────────

/**
 * Build the live port-state map that listServices joins against (keyed by
 * port): what IS running on this node, from the collected pieces.
 *
 * Signals, in precedence order:
 *  1. Docker container state for recipes with a containerName (running /
 *     not-running — the authoritative "is the process up" for container
 *     services).
 *  2. systemd unit state for recipes with a systemdUnit.
 *  3. Live LLM probes (backend != null → running, with modelId/engineVersion;
 *     backend null with no other signal → stopped).
 *  4. ComfyUI probe (port up → running, with version).
 *
 * A container reported running whose LLM probe failed (e.g. auth-gated or
 * still loading) stays "running" — the probe only adds model info when it
 * succeeds. No signal at all for a port → the recipe joins as "stopped".
 *
 * @param {object[]} recipes
 * @param {{
 *   containers?: object[],
 *   systemdUnits?: object[],
 *   llm?: object[],
 *   comfy?: object | null
 * }} live
 * @returns {Record<string, object>} port → LivePortState (shared/types.ts)
 */
export function buildLiveState(recipes, live = {}) {
  /** @type {Record<string, object>} */
  const state = {};
  const put = (port, partial) => {
    if (typeof port !== "number" || !Number.isInteger(port)) return;
    state[String(port)] = { ...(state[String(port)] || {}), ...partial };
  };
  const rs = Array.isArray(recipes) ? recipes : [];
  const containers = Array.isArray(live.containers) ? live.containers : [];
  const units = Array.isArray(live.systemdUnits) ? live.systemdUnits : [];
  const llm = Array.isArray(live.llm) ? live.llm : [];

  for (const r of rs) {
    if (!r || typeof r !== "object") continue;
    if (typeof r.containerName === "string" && r.containerName !== "") {
      const c = containers.find((x) => x && x.name === r.containerName);
      if (c && c.status === "running") put(r.port, { running: true });
      else if (c) put(r.port, { running: false });
    }
    if (typeof r.systemdUnit === "string" && r.systemdUnit !== "") {
      const u = units.find((x) => x && x.name === r.systemdUnit);
      if (u && u.status === "running") put(r.port, { running: true });
    }
  }
  for (const l of llm) {
    if (!l || typeof l !== "object") continue;
    if (l.backend != null) {
      put(l.port, {
        running: true,
        status: "running",
        modelId: typeof l.modelId === "string" && l.modelId !== "" ? l.modelId : null,
        engineVersion: l.version != null ? String(l.version) : null,
      });
    } else if (!state[String(l.port)]) {
      put(l.port, { running: false });
    }
  }
  const comfy = live.comfy;
  if (comfy && typeof comfy === "object" && comfy.port != null) {
    put(comfy.port, {
      running: true,
      status: "running",
      modelId: null,
      engineVersion: comfy.version != null ? String(comfy.version) : null,
    });
  }
  return state;
}

/**
 * Enrich a collected NodeAgentSnapshot with the catalog-derived fields that
 * assembleSnapshot leaves empty (services, memory, requests):
 *
 *  - services: listServices(recipes, liveState) — what CAN run joined with
 *    what IS running.
 *  - memory: computeMemoryBudget(mem.totalMB, mem.usedMB, services, 0, …) —
 *    report-only: the agent reserves nothing on its own (wantMB 0), so the
 *    panel shows total/used/free + per-service footprints; needMakeRoom is
 *    false until an orchestrator asks for a reservation through the catalog
 *    seam.
 *  - requests: one RequestStat per live LLM probe (backend != null) plus the
 *    ComfyUI probe, built from the probe's running/waiting counters and the
 *    vLLM finished counter (vllm:request_success_total). No live engines →
 *    null.
 *
 * Every section degrades to []/null on bad input — enrichment never breaks
 * the snapshot the collectors already produced.
 *
 * @param {object} snapshot NodeAgentSnapshot from collectTelemetry
 * @param {{ nodeId?: string, recipes?: object[] }} [opts]
 * @returns {object} the snapshot with services/memory/requests populated
 */
export function enrichSnapshot(snapshot, opts = {}) {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  const nodeId = typeof opts.nodeId === "string" && opts.nodeId !== "" ? opts.nodeId : snapshot.nodeId;
  const recipes = Array.isArray(opts.recipes) ? opts.recipes : [];
  const snap = { ...snapshot };

  const liveState = buildLiveState(recipes, {
    containers: snap.containers,
    systemdUnits: snap.systemd,
    llm: snap.llm,
    comfy: snap.comfy,
  });

  try {
    snap.services = listServices(recipes, liveState);
  } catch {
    snap.services = [];
  }

  const mem = snap.mem;
  if (mem && Number.isFinite(mem.totalMB) && Number.isFinite(mem.usedMB)) {
    try {
      snap.memory = computeMemoryBudget(
        mem.totalMB,
        mem.usedMB,
        snap.services.map((s) => ({
          name: s.name,
          kind: s.kind,
          footprintMB: s.footprintMB,
          running: s.status === "running",
          needed: s.active,
        })),
        0,
        { nodeId }
      );
    } catch {
      snap.memory = null;
    }
  }

  /** @type {object[]} */
  const stats = [];
  for (const l of Array.isArray(snap.llm) ? snap.llm : []) {
    if (!l || typeof l !== "object" || l.backend == null) continue;
    if (typeof l.port !== "number" || !Number.isInteger(l.port)) continue;
    stats.push({
      modelId: typeof l.modelId === "string" && l.modelId !== "" ? l.modelId : "unknown",
      engine: String(l.backend),
      nodeId,
      port: l.port,
      queued: Number.isFinite(l.requestsWaiting) ? l.requestsWaiting : 0,
      running: Number.isFinite(l.requestsRunning) ? l.requestsRunning : 0,
      // SGLang exposes no finished counter today → 0 (documented limitation).
      finished: Number.isFinite(l.requestsFinished) ? l.requestsFinished : 0,
      polledAt: snap.polledAt,
    });
  }
  const comfy = snap.comfy;
  if (comfy && typeof comfy === "object" && Number.isInteger(comfy.port)) {
    stats.push({
      modelId: "comfyui",
      engine: "comfyui",
      nodeId,
      port: comfy.port,
      queued: Number.isFinite(comfy.queuePending) ? comfy.queuePending : 0,
      running: Number.isFinite(comfy.queueRunning) ? comfy.queueRunning : 0,
      finished: 0,
      polledAt: snap.polledAt,
    });
  }
  snap.requests = stats.length > 0 ? { nodeId, stats, polledAt: snap.polledAt } : null;

  return snap;
}

/**
 * Build the node agent.
 *
 * Batch 1A + 1B + 2C: attaches the catalog seam (recipes, memory budgeting,
 * service registry), the telemetry HTTP server (collectTelemetry over
 * agent/collectors/), and the action layer (POST /actions, GET /audit) with
 * snapshot enrichment (services/memory/requests joined from the catalog).
 * @param {object} [opts]
 * @returns {{
 *   identity: object,
 *   catalog: {
 *     path: string,
 *     recipeFile: object,
 *     recipes: object[],
 *     getRecipe: (name: string) => object|null,
 *     listRecipes: () => object[],
 *     computeMemoryBudget: (totalMB: number, usedMB: number, services: object[], wantMB: number, opts?: object) => object,
 *     listServices: (liveState?: object) => object[]
 *   },
 *   start: () => Promise<{port:number, address:string}>,
 *   stop: () => Promise<void>
 * }}
 */
export function createNodeAgent(opts = {}) {
  const identity = readNodeIdentity(opts.env);
  const catalog = loadCatalog(opts.env, { force: Boolean(opts.reloadCatalog) });
  const httpServer = createHttpServer(
    () =>
      collectTelemetry(
        identity.nodeId,
        identity.nodeName,
        identity.lanIp,
        identity.llmPorts,
        identity.comfyPort,
        { llmAuthTokens: identity.llmAuthTokens }
      ).then((snap) => enrichSnapshot(snap, { nodeId: identity.nodeId, recipes: catalog.recipes })),
    identity.port,
    identity.bind,
    {
      agentVersion: AGENT_VERSION,
      token: identity.token,
      catalog: {
        getRecipe: (name) => getRecipe(name, catalog.recipeFile),
        listRecipes: () => listRecipes(catalog.recipeFile),
      },
      auditPath: identity.auditPath,
      llmAuthTokens: identity.llmAuthTokens,
    }
  );
  return {
    identity,
    catalog: {
      path: catalog.path,
      recipeFile: catalog.recipeFile,
      recipes: catalog.recipes,
      getRecipe: (name) => getRecipe(name, catalog.recipeFile),
      listRecipes: () => listRecipes(catalog.recipeFile),
      /** Memory budgeting with this node's identity pre-filled. */
      computeMemoryBudget: (totalMB, usedMB, services, wantMB, bOpts = {}) =>
        computeMemoryBudget(totalMB, usedMB, services, wantMB, {
          nodeId: identity.nodeId,
          ...bOpts,
        }),
      /** Join recipes + live state into ServiceInstance[]. */
      listServices: (liveState) => listServices(catalog.recipes, liveState),
    },
    start() {
      return httpServer.start().then((addr) => {
        console.log(
          JSON.stringify(
            {
              event: "node-agent up",
              agentVersion: AGENT_VERSION,
              nodeId: identity.nodeId,
              nodeName: identity.nodeName,
              lanIp: identity.lanIp,
              port: addr.port,
              bind: identity.bind,
              llmPorts: identity.llmPorts,
              comfyPort: identity.comfyPort,
              catalogPath: catalog.path,
              recipeCount: catalog.recipes.length,
            },
            null,
            2
          )
        );
        return addr;
      });
    },
    stop() {
      return httpServer.stop();
    },
  };
}

// `node main.js` runs for real: start the HTTP server, then print identity +
// catalog summary (Batch 0 behavior) + signal-driven graceful shutdown.
const isDirectRun =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isDirectRun) {
  const identity = readNodeIdentity();
  const catalog = loadCatalog();
  console.log(
    JSON.stringify(
      {
        agentVersion: AGENT_VERSION,
        identity,
        catalog: {
          path: catalog.path,
          recipeCount: catalog.recipes.length,
          recipes: catalog.recipes.map((r) => ({
            name: r.name,
            kind: r.kind,
            engine: r.engine,
            port: r.port,
            footprintMB: r.footprintMB,
          })),
        },
      },
      null,
      2
    )
  );
  const agent = createNodeAgent();
  agent.start().catch((err) => {
    console.error("[node-agent] failed to start:", err);
    process.exit(1);
  });
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
      console.log(`[node-agent] ${sig} received, shutting down`);
      agent
        .stop()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    });
  }
}
