/**
 * http.js — local HTTP API for the node agent (zero dependencies, node:http).
 *
 * Endpoints (JSON, CORS open for local use):
 *   GET  /            → identity + endpoint list
 *   GET  /health      → { ok: true, agentVersion }
 *   GET  /telemetry   → full NodeAgentSnapshot (calls snapshotFn live)
 *   GET  /versions    → snapshot.versions
 *   GET  /containers  → snapshot.containers
 *   POST /actions     → execute one ActionRequest via the action layer
 *                       (agent/actions/dispatch.js, recipe-catalog mapped);
 *                       body = ActionRequest (shared/types.ts),
 *                       response = ActionResponse
 *   GET  /audit       → last N audit entries (AuditEntry[]; ?limit=N,
 *                       default 50)
 *
 * Each telemetry/versions/containers request invokes snapshotFn() directly
 * (no cache) — the dashboard server owns poll pacing. POST /actions and
 * GET /audit call the action layer / audit log on demand.
 *
 * Optional bearer token (opts.token, from NODE_AGENT_TOKEN): required on
 * /telemetry, /versions, /containers, /actions, /audit. /health and / stay
 * open for liveness.
 */
import http from "node:http";

import { dispatchAction } from "./actions/dispatch.js";
import { readAudit, DEFAULT_READ_LIMIT } from "./actions/audit.js";

/** Hard cap on POST /actions body size (bytes). */
const ACTION_BODY_MAX_BYTES = 64 * 1024;
/** Hard cap on /audit ?limit= (bounds the response payload). */
const AUDIT_LIMIT_MAX = 1000;

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Read the full request body as a string (bounded).
 * @param {import("node:http").IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error(`body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Create the node-agent HTTP server.
 * @param {() => Promise<object>} snapshotFn returns a NodeAgentSnapshot
 * @param {number} [port] default 30091; 0 → ephemeral (tests)
 * @param {string} [bind] default "0.0.0.0"
 * @param {{
 *   agentVersion?: string,
 *   token?: string | null,
 *   catalog?: { getRecipe?: (name: string) => object | null, listRecipes?: () => object[] },
 *   auditPath?: string | null,
 *   llmAuthTokens?: Record<string, string>
 * }} [opts]
 * @returns {{ start: () => Promise<{port:number, address:string}>, stop: () => Promise<void> }}
 */
export function createHttpServer(snapshotFn, port = 30091, bind = "0.0.0.0", opts = {}) {
  const agentVersion = opts.agentVersion || "0.2.0";
  const token = opts.token || null;
  const catalog =
    opts.catalog && typeof opts.catalog === "object" ? opts.catalog : undefined;
  const auditPath =
    typeof opts.auditPath === "string" && opts.auditPath !== "" ? opts.auditPath : undefined;
  const llmAuthTokens =
    opts.llmAuthTokens && typeof opts.llmAuthTokens === "object" ? opts.llmAuthTokens : undefined;
  /** @type {import("node:http").Server | null} */
  let server = null;

  const handler = (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    let pathname;
    let searchParams = new URLSearchParams();
    try {
      const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      pathname = u.pathname;
      searchParams = u.searchParams;
    } catch {
      pathname = req.url || "/";
    }

    const authorized = !token || req.headers.authorization === `Bearer ${token}`;

    try {
      // ── POST /actions (the only POST route) ───────────────────────────
      if (req.method === "POST") {
        if (pathname !== "/actions") {
          json(res, 405, { error: "method not allowed" });
          return;
        }
        if (!authorized) {
          json(res, 401, { error: "unauthorized" });
          return;
        }
        readBody(req, ACTION_BODY_MAX_BYTES)
          .then((raw) => {
            let request;
            try {
              request = JSON.parse(raw === "" ? "null" : raw);
            } catch {
              throw Object.assign(new Error("invalid JSON body"), { httpStatus: 400 });
            }
            return dispatchAction(
              request,
              catalog && {
                getRecipe: catalog.getRecipe,
                listRecipes: catalog.listRecipes,
                snapshotFn,
                auditPath,
                llmAuthTokens,
              }
            ).then((response) => ({ status: 200, body: response }));
          })
          .then(({ status, body }) => json(res, status, body))
          .catch((err) => {
            const status =
              Number.isInteger(err?.httpStatus) && err.httpStatus >= 400 && err.httpStatus < 600
                ? err.httpStatus
                : 500;
            json(res, status, { error: String(err?.message || "action failed") });
          });
        return;
      }

      if (req.method !== "GET") {
        json(res, 405, { error: "method not allowed" });
        return;
      }

      if (pathname === "/") {
        json(res, 200, {
          name: "sparkdash-node-agent",
          version: agentVersion,
          endpoints: ["/telemetry", "/versions", "/containers", "/actions", "/audit", "/health"],
        });
        return;
      }
      if (pathname === "/health") {
        json(res, 200, { ok: true, agentVersion });
        return;
      }
      if (!authorized) {
        json(res, 401, { error: "unauthorized" });
        return;
      }

      if (pathname === "/telemetry" || pathname === "/versions" || pathname === "/containers") {
        Promise.resolve()
          .then(() => snapshotFn())
          .then((snap) => {
            if (pathname === "/telemetry") json(res, 200, snap);
            else if (pathname === "/versions") json(res, 200, snap?.versions ?? []);
            else json(res, 200, snap?.containers ?? []);
          })
          .catch((err) => {
            json(res, 500, {
              error: "telemetry failed",
              message: String(err?.message || err),
            });
          });
        return;
      }

      if (pathname === "/audit") {
        let limit = DEFAULT_READ_LIMIT;
        const rawLimit = searchParams.get("limit");
        if (rawLimit != null) {
          const n = Number(rawLimit);
          if (Number.isInteger(n) && n >= 0) limit = Math.min(n, AUDIT_LIMIT_MAX);
        }
        readAudit(limit, { path: auditPath })
          .then((entries) => json(res, 200, entries))
          .catch(() => json(res, 500, { error: "audit read failed" }));
        return;
      }

      json(res, 404, { error: "not found" });
    } catch {
      try {
        json(res, 500, { error: "internal error" });
      } catch {
        /* response already sent */
      }
    }
  };

  return {
    /**
     * Start listening.
     * @returns {Promise<{port:number, address:string}>}
     */
    async start() {
      if (server) return server.address() || { port: 0, address: "" };
      server = http.createServer(handler);
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, bind, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      const addr = server.address();
      return { port: addr?.port ?? port, address: addr?.address ?? bind };
    },

    /** Close the listener and any in-flight keep-alive connections. */
    async stop() {
      if (!server) return;
      const s = server;
      server = null;
      await new Promise((resolve, reject) => {
        s.close((err) => (err ? reject(err) : resolve()));
        if (typeof s.closeAllConnections === "function") s.closeAllConnections();
      });
    },
  };
}
