/**
 * dispatch.test.js — tests for the action dispatch layer (Batch 2C):
 * ActionRequest → action layer, mapped through the recipe catalog.
 *
 * Hermetic: the action layer's exec seams (docker execFile / systemd +
 * switch exec), the live snapshot (snapshotFn), and the audit log (tmp
 * path) are all injected; no daemon, no network, no repo state.
 *
 * Run: node --test agent/actions/__tests__/
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { dispatchAction, ActionError, ACTION_TYPES, makeAuthFetch } from "../dispatch.js";
import { readAudit } from "../audit.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

const RECIPES = [
  {
    name: "llm-tp1",
    kind: "llm",
    engine: "sglang",
    port: 8080,
    modelId: "qwen3.8-27b",
    containerName: "qwen38-sglang",
    systemdUnit: null,
  },
  {
    name: "llm-tp2",
    kind: "llm",
    engine: "vllm",
    port: 8000,
    modelId: "qwen3.8-27b",
    containerName: "qwen38-vllm-tp2",
    systemdUnit: null,
  },
  {
    name: "whisper",
    kind: "stt",
    engine: "whisper",
    port: 8881,
    modelId: null,
    containerName: null,
    systemdUnit: "whisper-server.service",
  },
  {
    name: "unactionable",
    kind: "other",
    engine: "other",
    port: 9999,
    modelId: null,
    containerName: null,
    systemdUnit: null,
  },
];

const CATALOG = {
  getRecipe: (name) => RECIPES.find((r) => r.name === name) ?? null,
  listRecipes: () => RECIPES,
};

/**
 * Live snapshot: llm-tp1 (sglang) currently RUNNING on 8080, llm-tp2 down.
 */
const SNAPSHOT = {
  nodeId: "gx10-test",
  versions: [
    {
      serviceName: "llm:8080",
      kind: "llm",
      engine: "sglang",
      version: "0.5.19",
      modelId: "qwen3.8-27b",
      port: 8080,
      state: "running",
    },
    {
      serviceName: "llm:8000",
      kind: "llm",
      engine: "vllm",
      version: "0.29.0",
      modelId: "qwen3.8-27b",
      port: 8000,
      state: "stopped",
    },
  ],
};

/** Recording execFile fake (docker.js seam): all calls exit 0. */
function fakeDockerExecFile() {
  const calls = [];
  const fn = (file, args, options, cb) => {
    calls.push({ file, args: [...args] });
    cb(null, "ok", "");
  };
  return { fn, calls };
}

/** Recording exec fake (systemd.js / llm-switch.js seam): all exit 0. */
function fakeExec() {
  const calls = [];
  const fn = async (file, args, runOpts) => {
    calls.push({ file, args: [...args], runOpts });
    return { exitCode: 0, stdout: "", stderr: "", notFound: false, timedOut: false };
  };
  return { fn, calls };
}

/** Canary fetch: the NEW port is immediately ready on /get_server_info. */
function fakeCanaryFetch() {
  const urls = [];
  const fn = async (url, init) => {
    urls.push({ url, init });
    if (url.endsWith("/health")) {
      return { status: 200, json: async () => ({}) };
    }
    if (url.endsWith("/get_server_info")) {
      return {
        status: 200,
        json: async () => ({
          model_path: "RadixArk/Qwen3.8-27B-NVFP4",
          context_length: 262144,
          version: "0.5.19",
          mem_fraction_static: 0.5,
        }),
      };
    }
    throw new Error("unexpected url: " + url);
  };
  return { fn, urls };
}

async function tmpAuditPath() {
  return path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), "sparkdash-dispatch-")),
    "audit.jsonl"
  );
}

/** @param {object} [overrides] */
function deps(overrides = {}) {
  const auditPath = overrides.auditPath || "";
  return {
    ...CATALOG,
    snapshotFn: async () => SNAPSHOT,
    auditPath: auditPath || undefined,
    ...overrides,
  };
}

// ── start / stop / restart ──────────────────────────────────────────────────

test("dispatch: start routes through recipe.containerName with exact argv", async () => {
  const docker = fakeDockerExecFile();
  const res = await dispatchAction(
    { actionId: "act-1", type: "start", serviceName: "llm-tp1" },
    deps({ execFile: docker.fn })
  );
  // Exact-argv through the catalog mapping: one docker call, container name
  // from the recipe, never the service name.
  assert.deepEqual(docker.calls, [{ file: "docker", args: ["start", "qwen38-sglang"] }]);
  assert.equal(res.serviceName, "llm-tp1");
  assert.equal(res.actionId, "act-1");
  assert.equal(res.status, "success");
  assert.equal(res.ok, true);
  assert.match(res.message, /docker start qwen38-sglang/);
  assert.equal(res.idempotent, true);
});

test("dispatch: stop + restart map to the matching docker verbs", async () => {
  for (const type of ["stop", "restart"]) {
    const docker = fakeDockerExecFile();
    const res = await dispatchAction(
      { type, serviceName: "llm-tp2" },
      deps({ execFile: docker.fn })
    );
    assert.deepEqual(docker.calls, [
      { file: "docker", args: [type, "qwen38-vllm-tp2"] },
    ]);
    assert.equal(res.status, "success");
    assert.match(res.message, new RegExp(`docker ${type} qwen38-vllm-tp2`));
  }
});

test("dispatch: systemd recipe routes to the unit action (exec seam, exit 0)", async () => {
  const exec = fakeExec();
  const res = await dispatchAction(
    { type: "restart", serviceName: "whisper", actionId: "act-unit" },
    deps({ exec: exec.fn })
  );
  assert.deepEqual(exec.calls, [
    {
      file: "systemctl",
      args: ["restart", "whisper-server.service"],
      runOpts: { timeoutMs: 30000 },
    },
  ]);
  assert.equal(res.ok, true);
  assert.equal(res.status, "success");
  assert.match(res.message, /systemctl restart whisper-server\.service/);
  assert.equal(res.serviceName, "whisper");
  assert.equal(res.idempotent, true);
});

// ── validation / lookup errors ──────────────────────────────────────────────

test("dispatch: invalid type / missing name / bad payload → ActionError 400", async () => {
  for (const request of [
    { type: "reboot", serviceName: "llm-tp1" },
    { type: "start" },
    { type: "start", serviceName: "   " },
    null,
    ["start"],
  ]) {
    await assert.rejects(
      dispatchAction(request, deps()),
      (err) => err instanceof ActionError && err.httpStatus === 400
    );
  }
});

test("dispatch: unknown service → ActionError 404", async () => {
  await assert.rejects(
    dispatchAction({ type: "start", serviceName: "ghost" }, deps()),
    (err) =>
      err instanceof ActionError && err.httpStatus === 404 && /unknown service 'ghost'/.test(err.message)
  );
});

test("dispatch: recipe without container/unit → ActionError 400 not actionable", async () => {
  await assert.rejects(
    dispatchAction({ type: "start", serviceName: "unactionable" }, deps()),
    (err) =>
      err instanceof ActionError &&
      err.httpStatus === 400 &&
      /not actionable/.test(err.message)
  );
});

// ── switch ──────────────────────────────────────────────────────────────────

test("dispatch: switch stops the running LLM (old port from live snapshot), starts the target, canary ready", async () => {
  const exec = fakeExec();
  const canary = fakeCanaryFetch();
  const res = await dispatchAction(
    {
      actionId: "act-switch",
      type: "switch",
      serviceName: "llm-tp1", // already running → oldPort discovery must skip it
      port: 8080,
    },
    deps({ exec: exec.fn, fetch: canary.fn })
  );
  // No other running LLM exists besides the target itself → oldPort null →
  // no stop step; the exec fake should see only the start of the target.
  assert.equal(res.ok, true);
  assert.equal(res.status, "success");
  assert.match(res.message, /LLM switch complete/);
  assert.deepEqual(
    exec.calls.map((c) => `${c.file} ${c.args.join(" ")}`),
    ["docker start qwen38-sglang"]
  );
  // Canary probed the target port with /health then /get_server_info.
  assert.ok(canary.urls[0].url.endsWith(":8080/health"));
  assert.ok(canary.urls.some((u) => u.url.endsWith(":8080/get_server_info")));
});

test("dispatch: switch with a different LLM running stops it first (catalog-resolved handle)", async () => {
  const exec = fakeExec();
  const canary = fakeCanaryFetch();
  const snap = {
    versions: [
      SNAPSHOT.versions[0], // sglang running on 8080
      { ...SNAPSHOT.versions[1], state: "running" }, // vllm ALSO running on 8000
    ],
  };
  const res = await dispatchAction(
    { type: "switch", serviceName: "llm-tp1", port: 8080 },
    deps({ exec: exec.fn, fetch: canary.fn, snapshotFn: async () => snap })
  );
  assert.equal(res.ok, true);
  // Stop the old LLM (8000 → qwen38-vllm-tp2), then start the target.
  assert.deepEqual(
    exec.calls.map((c) => `${c.file} ${c.args.join(" ")}`),
    ["docker stop qwen38-vllm-tp2", "docker start qwen38-sglang"]
  );
});

test("dispatch: switch canary auth — per-port bearer token reaches /get_server_info", async () => {
  const exec = fakeExec();
  const canary = fakeCanaryFetch();
  // No raw fetch seam: the auth wrapper (makeAuthFetch over the fake base)
  // must add the bearer header for the tokened port.
  await dispatchAction(
    { type: "switch", serviceName: "llm-tp1", port: 8080 },
    deps({ exec: exec.fn, fetch: makeAuthFetch({ "8080": "sekret" }, canary.fn) })
  );
  const infoCall = canary.urls.find((u) => u.url.endsWith("/get_server_info"));
  assert.ok(infoCall, "canary must probe /get_server_info");
  const headers = infoCall.init?.headers;
  const auth = headers instanceof Headers ? headers.get("authorization") : headers?.Authorization;
  assert.equal(auth, "Bearer sekret");
});

test("dispatch: switch refuses when live telemetry is unavailable (503, never guesses old LLM)", async () => {
  await assert.rejects(
    dispatchAction(
      { type: "switch", serviceName: "llm-tp2", port: 8000 },
      deps({ snapshotFn: async () => {
        throw new Error("telemetry down");
      } })
    ),
    (err) => err instanceof ActionError && err.httpStatus === 503
  );
});

test("dispatch: switch without snapshot source → 503", async () => {
  await assert.rejects(
    dispatchAction({ type: "switch", serviceName: "llm-tp2" }, { ...CATALOG }),
    (err) => err instanceof ActionError && err.httpStatus === 503
  );
});

test("dispatch: switch to an unactionable recipe → 400", async () => {
  await assert.rejects(
    dispatchAction({ type: "switch", serviceName: "unactionable", port: 9999 }, deps()),
    (err) => err instanceof ActionError && err.httpStatus === 400 && /cannot be switched/.test(err.message)
  );
});

// ── audit trail ─────────────────────────────────────────────────────────────

test("dispatch: every executed action appends one audit entry (shape + content)", async () => {
  const auditPath = await tmpAuditPath();
  try {
    const exec = fakeExec();
    await dispatchAction(
      {
        actionId: "act-a",
        type: "restart",
        serviceName: "whisper",
        port: 8881,
        modelId: null,
        engine: null,
      },
      deps({ auditPath, exec: exec.fn })
    );
    const entries = await readAudit(10, { path: auditPath });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].action, "restart");
    assert.equal(entries[0].serviceName, "whisper");
    assert.equal(entries[0].port, 8881);
    assert.equal(entries[0].engine, "whisper"); // from recipe when request omits it
    assert.equal(entries[0].status, "success");
    assert.match(entries[0].message, /systemctl restart whisper-server\.service/);
    assert.equal(typeof entries[0].ts, "number");
  } finally {
    await fs.rm(path.dirname(auditPath), { recursive: true, force: true });
  }
});

test("dispatch: switch audit entry carries request modelId/engine + recipe port fallback", async () => {
  const auditPath = await tmpAuditPath();
  try {
    const exec = fakeExec();
    const canary = fakeCanaryFetch();
    await dispatchAction(
      {
        type: "switch",
        serviceName: "llm-tp2",
        modelId: "qwen3.8-27b",
        engine: "vllm",
      },
      deps({ auditPath, exec: exec.fn, fetch: canary.fn, snapshotFn: async () => ({ versions: [] }) })
    );
    const entries = await readAudit(10, { path: auditPath });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].action, "switch");
    assert.equal(entries[0].serviceName, "llm-tp2");
    assert.equal(entries[0].port, 8000); // recipe.port (request had none)
    assert.equal(entries[0].modelId, "qwen3.8-27b");
    assert.equal(entries[0].engine, "vllm");
  } finally {
    await fs.rm(path.dirname(auditPath), { recursive: true, force: true });
  }
});

test("makeAuthFetch: bearer only for tokened ports, passthrough otherwise", async () => {
  const calls = [];
  const base = async (url, init) => {
    calls.push({ url, init });
    return { status: 200, json: async () => ({}) };
  };
  const wrapped = makeAuthFetch({ "8080": "sekret" }, base);
  assert.ok(typeof wrapped === "function");
  await wrapped("http://127.0.0.1:8080/get_server_info");
  await wrapped("http://127.0.0.1:8000/health");
  assert.equal(calls[0].init.headers.get("authorization"), "Bearer sekret");
  assert.ok(calls[1].init?.headers == null, "no header added for untokened port");
  // existing Authorization header is never overridden
  await wrapped("http://127.0.0.1:8080/health", { headers: { authorization: "Bearer mine" } });
  assert.equal(calls[2].init.headers.get("authorization"), "Bearer mine");
});

test("dispatch: ACTION_TYPES exposes exactly the seam union", () => {
  assert.deepEqual(ACTION_TYPES, ["start", "stop", "restart", "switch"]);
});
