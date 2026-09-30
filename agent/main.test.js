import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AGENT_VERSION,
  readNodeIdentity,
  resolveRecipesPath,
  loadCatalog,
  resetCatalog,
  createNodeAgent,
  buildLiveState,
  enrichSnapshot,
  parseLlmAuthTokens,
} from "./main.js";

test("readNodeIdentity: env overrides + defaults", () => {
  const id = readNodeIdentity({ HOSTNAME: "narthex", NODE_AGENT_PORT: "40000" });
  assert.equal(id.nodeId, "narthex");
  assert.equal(id.port, 40000);
  assert.equal(id.token, null);
  const d = readNodeIdentity({});
  assert.equal(d.nodeId, "unknown");
  assert.equal(d.port, 30091);
  assert.equal(d.bind, "0.0.0.0");
  assert.deepEqual(d.llmAuthTokens, {});
  assert.equal(d.auditPath, "");
});

test("readNodeIdentity: LLM_AUTH_TOKENS + audit path env", () => {
  const id = readNodeIdentity({
    HOSTNAME: "n",
    LLM_AUTH_TOKENS: "8080:abc,8000:def",
    NODE_AGENT_AUDIT_PATH: "/var/log/agent/audit.jsonl",
  });
  assert.deepEqual(id.llmAuthTokens, { "8080": "abc", "8000": "def" });
  assert.equal(id.auditPath, "/var/log/agent/audit.jsonl");
});

test("resolveRecipesPath: falls back to example when default is missing", () => {
  // agent/config/recipes.json does not exist in the repo — only the example.
  const p = resolveRecipesPath({});
  assert.ok(p.endsWith(path.join("config", "recipes.example.json")), p);
  assert.ok(fs.existsSync(p));
});

test("resolveRecipesPath: explicit RECIPES_PATH always wins", () => {
  assert.equal(resolveRecipesPath({ RECIPES_PATH: "/tmp/elsewhere.json" }), "/tmp/elsewhere.json");
});

test("loadCatalog: loads example, memoizes, reset clears", () => {
  resetCatalog();
  const a = loadCatalog({});
  assert.equal(a.recipes.length, 3);
  assert.deepEqual(
    a.recipes.map((r) => r.name),
    ["llm-tp1", "llm-tp2", "comfyui"]
  );
  assert.equal(loadCatalog({}), a); // memoized
  resetCatalog();
  assert.notEqual(loadCatalog({}), a);
  resetCatalog();
});

test("loadCatalog: explicit missing RECIPES_PATH → empty catalog, no throw", () => {
  resetCatalog();
  const catalog = loadCatalog({ RECIPES_PATH: path.join(os.tmpdir(), "definitely-missing-recipes.json") });
  assert.deepEqual(catalog.recipes, []);
  assert.equal(catalog.recipeFile.version, 1);
  assert.equal(catalog.recipeFile.nodeId, "unknown");
  resetCatalog();
});

// ── Snapshot enrichment (services / memory / requests) ─────────────────────

const RECIPES = [
  {
    name: "llm-tp1",
    kind: "llm",
    engine: "sglang",
    port: 8080,
    modelId: "qwen3.8-27b",
    footprintMB: 50000,
    containerName: "qwen38-sglang",
    systemdUnit: null,
  },
  {
    name: "llm-tp2",
    kind: "llm",
    engine: "vllm",
    port: 8000,
    modelId: "qwen3.8-27b",
    footprintMB: 90000,
    containerName: "qwen38-vllm-tp2",
    systemdUnit: null,
  },
  {
    name: "comfyui",
    kind: "image",
    engine: "comfyui",
    port: 8188,
    modelId: null,
    footprintMB: 40000,
    containerName: "comfyui",
    systemdUnit: null,
  },
];

const BASE_SNAP = {
  nodeId: "gx10-test",
  nodeName: "test",
  lanIp: "192.168.50.9",
  agentVersion: "0.2.0",
  online: true,
  uptimeSeconds: 1000,
  gpu: null,
  cpu: null,
  mem: { usedMB: 70000, totalMB: 124000, availableMB: 40000, percentage: 57 },
  disk: [],
  net: [],
  containers: [
    { name: "qwen38-sglang", image: "lmsysorg/sglang", status: "running" },
    { name: "comfyui", image: "comfy", status: "exited" },
  ],
  versions: [],
  services: [],
  memory: null,
  requests: null,
  topology: null,
  polledAt: 1234567890,
  llm: [
    { port: 8080, backend: "sglang", version: "0.5.19", modelId: "qwen3.8-27b", requestsRunning: 1, requestsWaiting: 2, requestsFinished: 41 },
    { port: 8000, backend: null },
  ],
  comfy: null,
  systemd: [],
};

test("buildLiveState: container state + probe overlay", () => {
  const state = buildLiveState(RECIPES, {
    containers: BASE_SNAP.containers,
    systemdUnits: [],
    llm: BASE_SNAP.llm,
    comfy: null,
  });
  // 8080: container running + probe ok → running with model info
  assert.equal(state["8080"].running, true);
  assert.equal(state["8080"].status, "running");
  assert.equal(state["8080"].modelId, "qwen3.8-27b");
  assert.equal(state["8080"].engineVersion, "0.5.19");
  // 8000: container absent, probe failed → stopped
  assert.equal(state["8000"].running, false);
  // 8188: container exited, no probe → stopped (docker state wins)
  assert.equal(state["8188"].running, false);
});

test("buildLiveState: running container + failed probe stays running (auth-gated LLM)", () => {
  const state = buildLiveState(RECIPES, {
    containers: [{ name: "qwen38-sglang", status: "running" }],
    llm: [{ port: 8080, backend: null }], // probe 401 → no model info
    systemdUnits: [],
    comfy: null,
  });
  assert.equal(state["8080"].running, true);
  assert.equal(state["8080"].modelId, undefined);
});

test("enrichSnapshot: services join live state with recipes", () => {
  const out = enrichSnapshot(BASE_SNAP, { nodeId: "gx10-test", recipes: RECIPES });
  assert.equal(out.services.length, 3);
  const llm1 = out.services.find((s) => s.name === "llm-tp1");
  assert.equal(llm1.status, "running");
  assert.equal(llm1.active, true);
  assert.equal(llm1.modelId, "qwen3.8-27b"); // live probe value, not recipe's
  const llm2 = out.services.find((s) => s.name === "llm-tp2");
  assert.equal(llm2.status, "stopped");
  assert.equal(llm2.active, false);
  const comfy = out.services.find((s) => s.name === "comfyui");
  assert.equal(comfy.status, "stopped");
  // original snapshot object untouched
  assert.equal(BASE_SNAP.services.length, 0);
});

test("enrichSnapshot: memory budget from mem + running services (wantMB 0 → report-only)", () => {
  const out = enrichSnapshot(BASE_SNAP, { nodeId: "gx10-test", recipes: RECIPES });
  const m = out.memory;
  assert.ok(m, "memory must be populated");
  assert.equal(m.nodeId, "gx10-test");
  assert.equal(m.totalMB, 124000);
  assert.equal(m.usedMB, 70000);
  assert.equal(m.freeMB, 54000);
  assert.equal(m.servicesUsedMB, 50000); // only llm-tp1 is running
  assert.equal(m.otherUsedMB, 20000);
  assert.equal(m.needMakeRoom, false);
  assert.deepEqual(m.makeRoom, []);
  const svc = m.services.find((s) => s.name === "llm-tp1");
  assert.equal(svc.running, true);
  assert.equal(svc.needed, true); // active LLM is never stoppable
});

test("enrichSnapshot: requests built from live LLM probes (+ comfy when present)", () => {
  const out = enrichSnapshot(BASE_SNAP, { nodeId: "gx10-test", recipes: RECIPES });
  const r = out.requests;
  assert.ok(r, "requests must be populated");
  assert.equal(r.nodeId, "gx10-test");
  assert.equal(r.polledAt, BASE_SNAP.polledAt);
  // only the live LLM (8080); the dead port (8000) contributes nothing
  assert.equal(r.stats.length, 1);
  assert.deepEqual(r.stats[0], {
    modelId: "qwen3.8-27b",
    engine: "sglang",
    nodeId: "gx10-test",
    port: 8080,
    queued: 2,
    running: 1,
    finished: 41,
    polledAt: BASE_SNAP.polledAt,
  });

  const withComfy = enrichSnapshot(
    { ...BASE_SNAP, comfy: { port: 8188, version: "0.3.1", queueRunning: 1, queuePending: 3 } },
    { nodeId: "gx10-test", recipes: RECIPES }
  );
  assert.equal(withComfy.requests.stats.length, 2);
  assert.deepEqual(withComfy.requests.stats[1], {
    modelId: "comfyui",
    engine: "comfyui",
    nodeId: "gx10-test",
    port: 8188,
    queued: 3,
    running: 1,
    finished: 0,
    polledAt: BASE_SNAP.polledAt,
  });
});

test("enrichSnapshot: no live engines → requests null; no mem → memory null", () => {
  const out = enrichSnapshot(
    { ...BASE_SNAP, llm: [{ port: 8080, backend: null }], mem: null },
    { nodeId: "gx10-test", recipes: RECIPES }
  );
  assert.equal(out.requests, null);
  assert.equal(out.memory, null);
  assert.equal(out.services.length, 3); // services still join (all stopped)
});

test("parseLlmAuthTokens: re-exported from the collector module", async () => {
  assert.equal(parseLlmAuthTokens, (await import("./collectors/llm.js")).parseLlmAuthTokens);
});

test("createNodeAgent: catalog seam works end-to-end", () => {
  resetCatalog();
  const agent = createNodeAgent({});
  assert.equal(typeof AGENT_VERSION, "string");
  const c = agent.catalog;
  assert.equal(c.getRecipe("llm-tp1").engine, "sglang");
  assert.equal(c.getRecipe("nope"), null);
  assert.equal(c.listRecipes().length, 3);

  const services = c.listServices({ 8080: { running: true, modelId: "qwen3.8-27b" } });
  assert.equal(services.length, 3);
  const llm = services.find((s) => s.name === "llm-tp1");
  assert.equal(llm.status, "running");
  assert.equal(llm.active, true);
  const comfy = services.find((s) => s.name === "comfyui");
  assert.equal(comfy.status, "stopped");
  assert.equal(comfy.active, false);

  const budget = c.computeMemoryBudget(122880, 70000, [], 40000);
  assert.equal(budget.nodeId, agent.identity.nodeId); // node id pre-filled
  assert.equal(budget.freeMB, 52880);
  assert.equal(budget.needMakeRoom, false);

  resetCatalog();
});
