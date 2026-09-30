/**
 * dispatch.js — action wiring: map an ActionRequest (shared/types.ts) to the
 * action layer through the recipe catalog.
 *
 * This is the seam the HTTP layer (agent/http.js POST /actions) calls:
 *
 *   import { dispatchAction } from "./actions/dispatch.js";
 *   const response = await dispatchAction(request, {
 *     getRecipe, listRecipes, snapshotFn, auditPath, llmAuthTokens
 *   });
 *
 * Mapping (per ActionRequest.type):
 *   start / stop / restart
 *     - recipe.containerName  → startContainer / stopContainer / restartContainer
 *     - else recipe.systemdUnit → startUnit / stopUnit / restartUnit
 *     - neither               → ActionError(400): not actionable on this node
 *   switch
 *     - new service = the requested recipe (newPort = request.port ?? recipe.port,
 *       newContainer / newUnit from the recipe)
 *     - old service = the LLM that is currently RUNNING on this node
 *       (live snapshot.versions, state "running", port != newPort; its
 *       container/unit resolved through the recipe catalog)
 *     - no running LLM → oldPort null (switchLlm skips the stop step)
 *
 * Every successfully dispatched action is appended to the audit log
 * (appendAudit, AuditEntry shape) before the response is returned.
 * appendAudit never throws, so auditing cannot break the action response.
 *
 * Errors: rejections carry an httpStatus (400 invalid request, 404 unknown
 * service, 400 not actionable, 503 live state unavailable for switch) —
 * http.js maps them to the same status with { error: message }. Anything
 * unexpected falls through to 500 in the HTTP layer.
 */
import { startContainer, stopContainer, restartContainer } from "./docker.js";
import { startUnit, stopUnit, restartUnit } from "./systemd.js";
import { switchLlm, validPort } from "./llm-switch.js";
import { appendAudit } from "./audit.js";

/** Action types the HTTP endpoint accepts (shared/types.ts ActionRequest.type). */
export const ACTION_TYPES = ["start", "stop", "restart", "switch"];

const CONTAINER_VERBS = {
  start: startContainer,
  stop: stopContainer,
  restart: restartContainer,
};
const UNIT_VERBS = {
  start: startUnit,
  stop: stopUnit,
  restart: restartUnit,
};

/**
 * Error with an HTTP status for the HTTP layer to surface.
 * @param {number} httpStatus
 * @param {string} message
 */
export class ActionError extends Error {
  constructor(httpStatus, message) {
    super(message);
    this.name = "ActionError";
    this.httpStatus = httpStatus;
  }
}

/**
 * @param {unknown} request the raw ActionRequest (parsed JSON body)
 * @param {{
 *   getRecipe?: (name: string) => object | null,
 *   listRecipes?: () => object[],
 *   snapshotFn?: () => Promise<object>,
 *   auditPath?: string,
 *   llmAuthTokens?: Record<string, string>,
 *   execFile?: (file: string, args: string[], options: object, cb: (err: Error | null, stdout: string, stderr: string) => void) => void,
 *   exec?: (file: string, args: string[], runOpts?: object) => Promise<object>,
 *   fetch?: (url: string, init?: object) => Promise<any>,
 *   baseFetch?: (url: string, init?: object) => Promise<any>
 * }} deps
 * @returns {Promise<object>} ActionResponse
 * @throws {ActionError} validation / lookup / live-state failures (with httpStatus)
 */
export async function dispatchAction(request, deps = {}) {
  const d = deps && typeof deps === "object" ? deps : {};

  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new ActionError(400, "action request must be a JSON object");
  }

  const type = request.type;
  if (!ACTION_TYPES.includes(type)) {
    throw new ActionError(
      400,
      `invalid action type: ${JSON.stringify(type)} (expected ${ACTION_TYPES.join("|")})`
    );
  }
  const serviceName =
    typeof request.serviceName === "string" ? request.serviceName.trim() : "";
  if (serviceName === "") {
    throw new ActionError(400, "serviceName is required (non-empty string)");
  }

  const getRecipe = typeof d.getRecipe === "function" ? d.getRecipe : () => null;
  const recipe = getRecipe(serviceName);
  if (!recipe || typeof recipe !== "object") {
    throw new ActionError(404, `unknown service '${serviceName}': no such recipe on this node`);
  }

  const actionId = typeof request.actionId === "string" ? request.actionId : "";
  const timeoutMs =
    typeof request.timeoutMs === "number" && Number.isFinite(request.timeoutMs) && request.timeoutMs > 0
      ? Math.round(request.timeoutMs)
      : undefined;

  const auditPort = validPort(request.port) ? Number(request.port) : null;

  /** @type {object} */
  let response;

  if (type === "switch") {
    response = await dispatchSwitch(request, recipe, d, { actionId, timeoutMs });
  } else {
    // start / stop / restart: resolve the handle through the recipe catalog.
    if (typeof recipe.containerName === "string" && recipe.containerName !== "") {
      response = await CONTAINER_VERBS[type](recipe.containerName, {
        actionId,
        serviceName,
        timeoutMs,
        // Test seam forwarding (docker.js opts.execFile) — production runs
        // the real child_process.execFile when absent.
        ...(typeof d.execFile === "function" ? { execFile: d.execFile } : {}),
      });
    } else if (typeof recipe.systemdUnit === "string" && recipe.systemdUnit !== "") {
      response = await UNIT_VERBS[type](
        recipe.systemdUnit,
        { actionId, serviceName, timeoutMs },
        typeof d.exec === "function" ? { exec: d.exec } : {}
      );
    } else {
      throw new ActionError(
        400,
        `service '${serviceName}' is not actionable on this node (recipe has no containerName or systemdUnit)`
      );
    }
  }

  // Audit: record what actually happened (status/message come from the action
  // result). appendAudit is side-effect-only and never throws.
  await appendAudit(
    {
      action: type,
      serviceName,
      port: auditPort ?? (Number.isFinite(recipe.port) ? recipe.port : null),
      modelId:
        typeof request.modelId === "string" && request.modelId !== ""
          ? request.modelId
          : recipe.modelId ?? null,
      engine:
        typeof request.engine === "string" && request.engine !== ""
          ? request.engine
          : recipe.engine ?? null,
      status: response.status,
      message: response.message,
      durationMs: response.durationMs ?? null,
    },
    { path: typeof d.auditPath === "string" && d.auditPath !== "" ? d.auditPath : undefined }
  );

  return response;
}

/**
 * Dispatch a switch action: stop the currently running LLM (if any), start
 * the requested service, canary-probe the new port.
 *
 * @param {object} request
 * @param {object} recipe target recipe (already looked up)
 * @param {object} d deps
 * @param {{actionId: string, timeoutMs?: number}} ids
 */
async function dispatchSwitch(request, recipe, d, { actionId, timeoutMs }) {
  const serviceName = request.serviceName.trim();
  const newPort = validPort(request.port) ? Number(request.port) : recipe.port;
  if (!validPort(newPort)) {
    throw new ActionError(400, `service '${serviceName}' has no valid port to switch onto`);
  }
  const newContainer =
    typeof recipe.containerName === "string" && recipe.containerName !== ""
      ? recipe.containerName
      : null;
  const newUnit =
    typeof recipe.systemdUnit === "string" && recipe.systemdUnit !== ""
      ? recipe.systemdUnit
      : null;
  if (!newContainer && !newUnit) {
    throw new ActionError(
      400,
      `service '${serviceName}' cannot be switched on this node (recipe has no containerName or systemdUnit)`
    );
  }

  // Live state: which LLM is running right now? (versions from the snapshot;
  // the catalog alone cannot say what is up.)
  if (typeof d.snapshotFn !== "function") {
    throw new ActionError(503, "cannot switch: no live snapshot source configured");
  }
  let snap;
  try {
    snap = await d.snapshotFn();
  } catch {
    throw new ActionError(503, "cannot switch: live telemetry unavailable on this node");
  }
  const versions = Array.isArray(snap?.versions) ? snap.versions : [];
  const runningLlms = versions.filter(
    (v) =>
      v &&
      v.kind === "llm" &&
      v.state === "running" &&
      validPort(v.port) &&
      Number(v.port) !== newPort
  );
  const oldPort = runningLlms.length > 0 ? Number(runningLlms[0].port) : null;

  const oldRecipe =
    oldPort != null && typeof d.listRecipes === "function"
      ? (d.listRecipes().find((r) => r && r.port === oldPort) ?? null)
      : null;
  const oldContainer =
    oldRecipe && typeof oldRecipe.containerName === "string" && oldRecipe.containerName !== ""
      ? oldRecipe.containerName
      : null;
  const oldUnit =
    oldRecipe && typeof oldRecipe.systemdUnit === "string" && oldRecipe.systemdUnit !== ""
      ? oldRecipe.systemdUnit
      : null;

  // Canary-probe fetch: test seam (d.fetch) wins; otherwise per-port bearer
  // wrapping when tokens are configured; otherwise the global fetch.
  const tokens = d.llmAuthTokens && typeof d.llmAuthTokens === "object" ? d.llmAuthTokens : {};
  const baseFetch = typeof d.baseFetch === "function" ? d.baseFetch : fetch;
  const fetchFn =
    typeof d.fetch === "function"
      ? d.fetch
      : Object.keys(tokens).length > 0
        ? makeAuthFetch(tokens, baseFetch)
        : undefined;

  return switchLlm(oldPort, newPort, {
    actionId,
    serviceName,
    timeoutMs,
    oldUnit,
    oldContainer,
    newUnit,
    newContainer,
    fetch: fetchFn,
    // Test seam forwarding (llm-switch.js opts.exec) — production uses the
    // real runExec when absent.
    ...(typeof d.exec === "function" ? { exec: d.exec } : {}),
  });
}

/**
 * fetch wrapper that adds `Authorization: Bearer <token>` for ports that
 * have a token configured. Never throws: falls back to the base fetch.
 * Exported for tests (and future reuse by orchestrators).
 * @param {Record<string, string>} tokens port (string) → bearer token
 * @param {(url: string, init?: object) => Promise<any>} [base]
 * @returns {(url: string, init?: object) => Promise<any> | undefined}
 */
export function makeAuthFetch(tokens, base = fetch) {
  const baseFetch = typeof base === "function" ? base : undefined;
  if (typeof baseFetch !== "function") return undefined;
  /** @param {string} url @param {object} [init] */
  return (url, init) => {
    try {
      const u = new URL(url);
      const token = tokens[u.port];
      if (token) {
        const headers = new Headers(init?.headers);
        if (!headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
        return baseFetch(url, { ...init, headers });
      }
    } catch {
      /* fall through to plain fetch */
    }
    return baseFetch(url, init);
  };
}
