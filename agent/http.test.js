import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { createHttpServer } from "./http.js";
import { DEFAULT_READ_LIMIT } from "./actions/audit.js";

const SNAPSHOT = {
  nodeId: "narthex",
  nodeName: "Narthex",
  lanIp: "192.168.50.150",
  agentVersion: "0.1.0",
  online: true,
  uptimeSeconds: 100,
  gpu: null,
  cpu: null,
  mem: null,
  disk: [],
  net: [],
  containers: [{ name: "c1", image: "img:1", imageDigest: null, status: "running", uptimeSeconds: 5, ports: [], memUsedMB: null, memLimitMB: null, cpuPercent: null }],
  versions: [{ serviceName: "llm:8080", kind: "llm", engine: "vllm", engineVersion: null, modelId: "m", modelPath: null, modelRevision: null, quantization: null, contextLength: 1000, memFraction: null, tpSize: null, port: 8080, state: "running", polledAt: 1 }],
  services: [],
  memory: null,
  requests: null,
  topology: null,
  polledAt: 1,
};

async function withServer(opts, fn) {
  let calls = 0;
  const server = createHttpServer(async () => {
    calls += 1;
    return SNAPSHOT;
  }, 0, "127.0.0.1", opts);
  const addr = await server.start();
  const base = `http://127.0.0.1:${addr.port}`;
  try {
    await fn(base, calls, () => calls);
  } finally {
    await server.stop();
  }
}

/**
 * A catalog that dispatchAction can actually route through: one docker
 * service (llm-tp1 → qwen38-sglang), one systemd service (whisper →
 * whisper-server.service), and one unactionable one (nope-recipe).
 */
const CATALOG = {
  getRecipe: (name) =>
    ({
      "llm-tp1": {
        name: "llm-tp1",
        kind: "llm",
        engine: "sglang",
        port: 8080,
        modelId: "qwen3.8-27b",
        containerName: "qwen38-sglang",
        systemdUnit: null,
      },
      whisper: {
        name: "whisper",
        kind: "stt",
        engine: "whisper",
        port: 8881,
        containerName: null,
        systemdUnit: "whisper-server.service",
      },
      "nope-recipe": {
        name: "nope-recipe",
        kind: "other",
        engine: "other",
        port: 9999,
        containerName: null,
        systemdUnit: null,
      },
    })[name] ?? null,
  listRecipes: () => ["llm-tp1", "whisper", "nope-recipe"].map((n) => CATALOG.getRecipe(n)),
};

test("http: identity + health endpoints", async () => {
  await withServer({ agentVersion: "0.2.0" }, async (base) => {
    const root = await fetch(`${base}/`);
    assert.equal(root.status, 200);
    assert.equal(root.headers.get("content-type"), "application/json");
    assert.deepEqual(await root.json(), {
      name: "sparkdash-node-agent",
      version: "0.2.0",
      endpoints: ["/telemetry", "/versions", "/containers", "/actions", "/audit", "/health"],
    });

    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, agentVersion: "0.2.0" });
  });
});

test("http: /telemetry, /versions, /containers return live snapshot slices", async () => {
  await withServer({}, async (base, _calls, getCalls) => {
    const t = await (await fetch(`${base}/telemetry`)).json();
    assert.equal(t.nodeId, "narthex");
    assert.equal(getCalls(), 1);

    const v = await (await fetch(`${base}/versions`)).json();
    assert.deepEqual(v, SNAPSHOT.versions);

    const c = await (await fetch(`${base}/containers`)).json();
    assert.deepEqual(c, SNAPSHOT.containers);
  });
});

test("http: CORS allows all origins; OPTIONS preflight handled", async () => {
  await withServer({}, async (base) => {
    const res = await fetch(`${base}/telemetry`);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    const pre = await fetch(`${base}/telemetry`, { method: "OPTIONS" });
    assert.equal(pre.status, 204);
  });
});

test("http: unknown route → 404 JSON; non-GET → 405 JSON", async () => {
  await withServer({}, async (base) => {
    const nf = await fetch(`${base}/nope`);
    assert.equal(nf.status, 404);
    assert.deepEqual(await nf.json(), { error: "not found" });
    const bad = await fetch(`${base}/telemetry`, { method: "POST" });
    assert.equal(bad.status, 405);
    // POST on any non-/actions route is also 405
    const bad2 = await fetch(`${base}/audit`, { method: "POST" });
    assert.equal(bad2.status, 405);
  });
});

test("http: snapshotFn failure → 500 JSON (no hang, no crash)", async () => {
  const server = createHttpServer(
    async () => {
      throw new Error("boom");
    },
    0,
    "127.0.0.1"
  );
  const addr = await server.start();
  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}/telemetry`);
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error, "telemetry failed");
    assert.match(body.message, /boom/);
  } finally {
    await server.stop();
  }
});

test("http: bearer token knob (non-default) guards data endpoints, leaves /health open", async () => {
  await withServer({ token: "sekret" }, async (base) => {
    const open = await fetch(`${base}/health`);
    assert.equal(open.status, 200);

    const denied = await fetch(`${base}/telemetry`);
    assert.equal(denied.status, 401);
    assert.deepEqual(await denied.json(), { error: "unauthorized" });

    const wrong = await fetch(`${base}/telemetry`, {
      headers: { authorization: "Bearer wrong" },
    });
    assert.equal(wrong.status, 401);

    const ok = await fetch(`${base}/telemetry`, {
      headers: { authorization: "Bearer sekret" },
    });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).nodeId, "narthex");
  });
});

test("http: stop() closes the listener (subsequent connect fails)", async () => {
  const server = createHttpServer(async () => ({}), 0, "127.0.0.1");
  const addr = await server.start();
  await server.stop();
  await assert.rejects(
    fetch(`http://127.0.0.1:${addr.port}/health`),
    /fetch failed|ECONNREFUSED/
  );
  // stop() is idempotent
  await server.stop();
});

// ── POST /actions ────────────────────────────────────────────────────────────

/** POST a JSON body to /actions; returns {status, body}. */
async function postAction(base, body, headers = {}) {
  const res = await fetch(`${base}/actions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test("http: POST /actions runs a docker action through the catalog + dispatch", async () => {
  await withServer({ catalog: CATALOG }, async (base) => {
    // Real dispatch: docker start on qwen38-sglang — no docker binary here,
    // so the action layer resolves "docker not found"; what's under test is
    // the HTTP wiring: valid request → 200 ActionResponse (ok=false is data).
    const r = await postAction(base, {
      actionId: "act-http-1",
      type: "start",
      serviceName: "llm-tp1",
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.actionId, "act-http-1");
    assert.equal(r.body.serviceName, "llm-tp1");
    assert.equal(r.body.status, "failure"); // docker missing in this test env
    assert.equal(r.body.ok, false);
    assert.match(r.body.message, /docker start qwen38-sglang/);
    assert.equal(typeof r.body.at, "number");
  });
});

test("http: POST /actions maps a systemd recipe to the unit action", async () => {
  await withServer({ catalog: CATALOG }, async (base) => {
    const r = await postAction(base, { type: "restart", serviceName: "whisper" });
    assert.equal(r.status, 200);
    // systemctl exists in this env? Either way the wiring is proven: the
    // message must name the unit, and the response must be an ActionResponse.
    assert.match(r.body.message, /whisper-server\.service/);
    assert.equal(r.body.serviceName, "whisper");
    assert.ok(["success", "failure"].includes(r.body.status));
  });
});

test("http: POST /actions validation + lookup errors → 400/404 JSON", async () => {
  await withServer({ catalog: CATALOG }, async (base) => {
    const badType = await postAction(base, { type: "reboot", serviceName: "llm-tp1" });
    assert.equal(badType.status, 400);
    assert.match(badType.body.error, /invalid action type/);

    const noName = await postAction(base, { type: "start" });
    assert.equal(noName.status, 400);
    assert.match(noName.body.error, /serviceName is required/);

    const unknown = await postAction(base, { type: "start", serviceName: "ghost" });
    assert.equal(unknown.status, 404);
    assert.match(unknown.body.error, /unknown service 'ghost'/);

    const notActionable = await postAction(base, { type: "stop", serviceName: "nope-recipe" });
    assert.equal(notActionable.status, 400);
    assert.match(notActionable.body.error, /not actionable/);
  });
});

test("http: POST /actions with malformed JSON body → 400", async () => {
  await withServer({ catalog: CATALOG }, async (base) => {
    const res = await fetch(`${base}/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "invalid JSON body" });
  });
});

test("http: POST /actions token guard mirrors /telemetry", async () => {
  await withServer({ token: "sekret", catalog: CATALOG }, async (base) => {
    const denied = await postAction(base, { type: "start", serviceName: "llm-tp1" });
    assert.equal(denied.status, 401);
    assert.deepEqual(denied.body, { error: "unauthorized" });

    const wrong = await postAction(
      base,
      { type: "start", serviceName: "llm-tp1" },
      { authorization: "Bearer wrong" }
    );
    assert.equal(wrong.status, 401);

    const ok = await postAction(
      base,
      { type: "start", serviceName: "llm-tp1" },
      { authorization: "Bearer sekret" }
    );
    assert.equal(ok.status, 200);
  });
});

test("http: POST /actions without a catalog → 404 for every service", async () => {
  await withServer({}, async (base) => {
    const r = await postAction(base, { type: "start", serviceName: "llm-tp1" });
    assert.equal(r.status, 404);
    assert.match(r.body.error, /no such recipe/);
  });
});

test("http: POST /actions surfaces dispatchAction 5xx (live state unavailable)", async () => {
  const server = createHttpServer(
    async () => {
      throw new Error("telemetry down");
    },
    0,
    "127.0.0.1",
    {
      catalog: CATALOG,
    }
  );
  const addr = await server.start();
  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "switch", serviceName: "llm-tp1" }),
    });
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /live telemetry unavailable/);
  } finally {
    await server.stop();
  }
});

// ── GET /audit ───────────────────────────────────────────────────────────────

test("http: GET /audit returns entries written by dispatchAction", async () => {
  const fs = await import("node:fs/promises");
  const auditPath = path.join(os.tmpdir(), `sparkdash-audit-${Date.now()}.jsonl`);
  try {
    // Write two entries through the real audit module — sequentially, so
    // file order is deterministic (append-only).
    const { appendAudit } = await import("./actions/audit.js");
    await appendAudit(
      {
        action: "start",
        serviceName: "llm-tp1",
        port: 8080,
        modelId: "qwen3.8-27b",
        engine: "sglang",
        status: "success",
        message: "docker start qwen38-sglang → exit 0",
        durationMs: 42,
      },
      { path: auditPath }
    );
    await appendAudit(
      {
        action: "stop",
        serviceName: "comfyui",
        port: 8188,
        modelId: null,
        engine: "comfyui",
        status: "success",
        message: "docker stop comfyui → exit 0",
        durationMs: 11,
      },
      { path: auditPath }
    );

    await withServer({ auditPath }, async (base) => {
      const all = await (await fetch(`${base}/audit`)).json();
      assert.equal(all.length, 2);
      assert.equal(all[0].action, "start"); // file order preserved (oldest first)
      assert.equal(all[1].serviceName, "comfyui");
      assert.equal(typeof all[0].ts, "number");

      const one = await (await fetch(`${base}/audit?limit=1`)).json();
      assert.equal(one.length, 1);
      assert.equal(one[0].action, "stop"); // most recent entry

      const none = await (await fetch(`${base}/audit?limit=0`)).json();
      assert.deepEqual(none, []);

      // invalid limit → default (DEFAULT_READ_LIMIT), not an error
      const def = await (await fetch(`${base}/audit?limit=banana`)).json();
      assert.equal(def.length, 2);
      assert.ok(DEFAULT_READ_LIMIT >= 2);
    });
  } finally {
    await fs.rm(auditPath, { force: true });
  }
});

test("http: GET /audit missing file → [] (graceful, no 500)", async () => {
  await withServer(
    { auditPath: "/nonexistent/dir/audit.jsonl" },
    async (base) => {
      const res = await fetch(`${base}/audit`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), []);
    }
  );
});

test("http: GET /audit token guard mirrors /telemetry", async () => {
  await withServer({ token: "sekret", auditPath: "/nonexistent/audit.jsonl" }, async (base) => {
    const denied = await fetch(`${base}/audit`);
    assert.equal(denied.status, 401);
    const ok = await fetch(`${base}/audit`, { headers: { authorization: "Bearer sekret" } });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), []);
  });
});
