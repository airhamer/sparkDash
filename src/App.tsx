import { useState, useCallback, useEffect, useMemo } from "react";
import { useSnapshot } from "./hooks/useSnapshot";
import { useAppRoute, useRoute, useFleetRoute, type FleetView } from "./hooks/useRoute";
import { fetchSparks, reorderSparks, fetchSettings, sendNodeAction } from "./api/client";
import { useFleetData } from "./hooks/useFleet";
import { SparkTabs } from "./components/SparkTabs";
import { AddSparkDialog } from "./components/AddSparkDialog";
import { EditSparkDialog } from "./components/EditSparkDialog";
import { SparkPage } from "./components/SparkPage/SparkPage";
import { NodeDetail } from "./components/SparkPage/NodeDetail";
import { HermesUpdateDialog } from "./components/SparkPage/HermesUpdateDialog";
import { OverviewPage } from "./components/OverviewPage/OverviewPage";
import { FleetPage } from "./components/OverviewPage/FleetPage";
import { ShowcasePage } from "./components/ShowcasePage/ShowcasePage";
import { TopologyPage } from "./components/Topology/TopologyPage";
import { ServiceManagerPage } from "./components/ServiceManager/ServiceManagerPage";
import { RequestsPage } from "./components/Requests/RequestsPage";
import { ThemeSwitch } from "./components/ThemeSwitch";
import { SettingsDialog } from "./components/SettingsDialog";
import { GearIcon, BoltIcon } from "./components/ui/icons";
import { ConnectionBanner } from "./components/ui/ConnectionBanner";
import { ErrorBanner } from "./components/ui/ErrorBanner";
import { OVERVIEW_ID } from "./constants";
import type { Settings, SparkSnapshot, FleetSnapshot } from "./api/types";
import type { NodeRole } from "../shared/types";
import { isWorkerSpark } from "./api/sparkRole";

/** Keep hidden worker ids in their original slots when the visible tabs are reordered. */
function mergeTabOrderKeepingHidden(
  allSparks: SparkSnapshot[],
  visibleOrder: string[],
  hiddenIds: Set<string>
): string[] {
  if (hiddenIds.size === 0) return visibleOrder;
  const result: string[] = [];
  let vi = 0;
  for (const spark of allSparks) {
    if (hiddenIds.has(spark.id)) {
      result.push(spark.id);
    } else if (vi < visibleOrder.length) {
      result.push(visibleOrder[vi++]);
    }
  }
  while (vi < visibleOrder.length) result.push(visibleOrder[vi++]);
  return result;
}

function placeholderSnapshot(
  id: string,
  name: string,
  disabledDevices: string[] = [],
  disabledInterfaces: string[] = [],
  llmPorts: number[] = [8888],
  roleFields?: {
    role?: SparkSnapshot["role"];
    workerNode?: boolean;
    workerLabel?: string | null;
    workerHeadId?: string | null;
    llmMonitoring?: boolean;
    comfyMonitoring?: boolean;
    comfyPort?: number;
    tailscaleMonitoring?: boolean;
    kind?: "spark" | "host";
  }
): SparkSnapshot {
  const role =
    roleFields?.role === "head" ||
    roleFields?.role === "worker" ||
    roleFields?.role === "standalone"
      ? roleFields.role
      : roleFields?.workerNode
        ? "worker"
        : "standalone";
  const workerNode = role === "worker";
  return {
    id,
    name,
    kind: roleFields?.kind ?? "spark",
    online: false,
    uptime: null,
    disabledDevices,
    disabledInterfaces,
    llmPort: llmPorts[0] ?? 8888,
    llmPorts,
    workerNode,
    role,
    workerLabel: workerNode ? roleFields?.workerLabel ?? null : null,
    workerHeadId: workerNode ? roleFields?.workerHeadId ?? null : null,
    llmMonitoring:
      role === "worker"
        ? false
        : role === "head"
          ? true
          : roleFields?.llmMonitoring !== false,
    comfyMonitoring: Boolean(roleFields?.comfyMonitoring),
    comfyPort: roleFields?.comfyPort ?? 8188,
    tailscaleMonitoring: Boolean(roleFields?.tailscaleMonitoring),
    hermes: {
      monitoring: false,
      installed: null,
      version: null,
      updateAvailable: null,
      behindCommits: null,
      checkedAt: null,
      status: "idle",
      startedAt: null,
      finishedAt: null,
      error: null,
    },
    hardware: {
      device: "NVIDIA DGX Spark",
      cpuModel: "…",
      cpuCores: 0,
      totalMemoryGB: 0,
      gpuChip: "…",
      cudaDriver: null,
      storageModel: null,
    },
    metrics: {
      gpu: null,
      cpu: null,
      ram: null,
      storage: [],
      network: null,
      unifiedMemory: null,
      llm: [],
      comfy: null,
      tailscale: null,
    },
  };
}

function DashboardApp() {
  const {
    sparks,
    activeId,
    setActiveId,
    activeSpark,
    connected,
    lastValidSnapshotAt,
    snapshotError,
    refreshInterval,
  } = useSnapshot();
  const [telemetryNow, setTelemetryNow] = useState(Date.now());
  const navigate = useRoute(setActiveId);
  const { view: fleetView, navigate: fleetNavigate } = useFleetRoute();
  const inFleet = fleetView != null;
  const { snapshot: fleet, error: fleetError } = useFleetData(inFleet);

  /** Leave any fleet view (URL replaced, no extra history entry), then switch spark. */
  const goSpark = useCallback(
    (id: string | null) => {
      if (fleetView) fleetNavigate(null);
      navigate(id);
    },
    [fleetView, fleetNavigate, navigate]
  );
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /** Used when WS is down so add/delete still updates the tab bar */
  const [fallbackSparks, setFallbackSparks] = useState<SparkSnapshot[]>([]);
  const staleAfterMs = Math.max(10_000, 3 * (refreshInterval ?? 2_000));
  const telemetryStale =
    lastValidSnapshotAt != null && telemetryNow - lastValidSnapshotAt > staleAfterMs;

  useEffect(() => {
    if (lastValidSnapshotAt == null) return;
    setTelemetryNow(Date.now());
    const timer = window.setInterval(() => setTelemetryNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [lastValidSnapshotAt]);

  // Prefer live WS data; fall back to API-fetched list when empty
  const liveSparks = sparks.length > 0 ? sparks : fallbackSparks;
  /** Optimistic tab order while drag-save races the next WS snapshot */
  const [orderOverride, setOrderOverride] = useState<string[] | null>(null);

  const displaySparks = useMemo(() => {
    if (!orderOverride?.length) return liveSparks;
    const map = new Map(liveSparks.map((s) => [s.id, s]));
    const ordered: SparkSnapshot[] = [];
    for (const id of orderOverride) {
      const s = map.get(id);
      if (s) {
        ordered.push(s);
        map.delete(id);
      }
    }
    for (const s of map.values()) ordered.push(s);
    return ordered;
  }, [liveSparks, orderOverride]);

  // Drop override once server/WS order matches
  useEffect(() => {
    if (!orderOverride) return;
    const live = liveSparks.map((s) => s.id).join("\0");
    if (live === orderOverride.join("\0")) setOrderOverride(null);
  }, [liveSparks, orderOverride]);


  const isOverview = activeId === OVERVIEW_ID;
  const hideWorkers = settings?.hideWorkers ?? false;
  const hiddenWorkerIds = useMemo(() => {
    if (!hideWorkers) return new Set<string>();
    return new Set(
      displaySparks
        .filter((s) => isWorkerSpark(s) && s.id !== activeId)
        .map((s) => s.id)
    );
  }, [displaySparks, hideWorkers, activeId]);
  const tabSparks = useMemo(
    () => (hideWorkers ? displaySparks.filter((s) => !hiddenWorkerIds.has(s.id)) : displaySparks),
    [displaySparks, hideWorkers, hiddenWorkerIds]
  );
  const displayActive = isOverview
    ? null
    : displaySparks.find((s) => s.id === activeId) || displaySparks[0] || activeSpark || null;

  useEffect(() => {
    if (sparks.length > 0) setFallbackSparks([]);
  }, [sparks]);

  // Fetch global settings on mount
  useEffect(() => {
    fetchSettings()
      .then(setSettings)
      .catch((err) =>
        setActionError(
          `Could not load settings: ${err instanceof Error ? err.message : String(err)}. Reload to retry.`
        )
      );
  }, []);

  const handleSettingsSaved = useCallback((s: Settings) => {
    setSettings(s);
  }, []);

  // Apply layout density (comfortable/compact) from persisted settings.
  useEffect(() => {
    if (settings?.density) {
      document.documentElement.setAttribute("data-density", settings.density);
    }
  }, [settings?.density]);

  const refreshFromApi = useCallback(async () => {
    try {
      const { sparks: configs } = await fetchSparks();
      setFallbackSparks(
        configs.map((c) => {
          const existing = sparks.find((s) => s.id === c.id);
          if (existing) {
            // Keep live metrics, but never let a stale WS snapshot override
            // role fields that were just saved via the API.
            return {
              ...existing,
              name: c.name,
              role: c.role ?? existing.role,
              workerNode: c.workerNode ?? existing.workerNode,
              workerLabel: c.workerLabel ?? existing.workerLabel,
              workerHeadId: c.workerHeadId ?? existing.workerHeadId,
              llmMonitoring: c.llmMonitoring ?? existing.llmMonitoring,
              comfyMonitoring: c.comfyMonitoring ?? existing.comfyMonitoring,
              comfyPort: c.comfyPort ?? existing.comfyPort,
              tailscaleMonitoring: c.tailscaleMonitoring ?? existing.tailscaleMonitoring,
              disabledDevices: c.disabledDevices || existing.disabledDevices,
              disabledInterfaces: c.disabledInterfaces || existing.disabledInterfaces,
              llmPorts: c.llmPorts ?? existing.llmPorts,
              llmPort: c.llmPorts?.[0] ?? c.llmPort ?? existing.llmPort,
              kind: c.kind ?? existing.kind,
            };
          }
          return placeholderSnapshot(
            c.id,
            c.name,
            c.disabledDevices || [],
            c.disabledInterfaces || [],
            c.llmPorts ?? (c.llmPort ? [c.llmPort] : [8888]),
            {
              role: c.role,
              workerNode: c.workerNode,
              workerLabel: c.workerLabel,
              workerHeadId: c.workerHeadId,
              llmMonitoring: c.llmMonitoring,
              comfyMonitoring: c.comfyMonitoring,
              comfyPort: c.comfyPort,
              tailscaleMonitoring: c.tailscaleMonitoring,
              kind: c.kind,
            }
          );
        })
      );
      if (configs.length && activeId !== OVERVIEW_ID && !configs.some((c) => c.id === activeId)) {
        setActiveId(configs[0].id);
      }
      if (configs.length === 0 && activeId !== OVERVIEW_ID) setActiveId(null);
    } catch (err) {
      console.error("Failed to refresh sparks:", err);
      setActionError(
        `Could not refresh Sparks: ${err instanceof Error ? err.message : String(err)}. Previous data remains visible.`
      );
    }
  }, [sparks, activeId, setActiveId]);

  const handleReorder = useCallback(
    async (orderedIds: string[]) => {
      const next = mergeTabOrderKeepingHidden(displaySparks, orderedIds, hiddenWorkerIds);
      setOrderOverride(next);
      try {
        await reorderSparks(next);
      } catch (err) {
        console.error("Failed to reorder Sparks:", err);
        setOrderOverride(null);
        setActionError(
          `Could not save the Spark order: ${err instanceof Error ? err.message : String(err)}. The previous order was restored.`
        );
      }
    },
    [displaySparks, hiddenWorkerIds]
  );

  return (
    <div className="min-h-screen p-0 text-text sm:p-8">
      <div className="dashboard-shell">
        <header className="flex flex-wrap items-center gap-3" style={{ marginBottom: "var(--density-header-gap)" }}>
          <button
            type="button"
            onClick={() => (inFleet ? fleetNavigate({ page: "fleet" }) : goSpark(OVERVIEW_ID))}
            className="logo-pill"
          >
            <BoltIcon className="h-3.5 w-3.5 text-accent" />
            <span>
              spark<span className="logo-pill-dash">Dash</span>
            </span>
          </button>
          <nav
            aria-label="Views"
            className="flex items-center gap-0.5 rounded-lg border border-border bg-surface p-0.5"
          >
            <ViewTab label="Sparks" active={!inFleet} onClick={() => goSpark(OVERVIEW_ID)} />
            <ViewTab
              label="Fleet"
              active={inFleet && fleetView?.page !== "topology"}
              onClick={() => fleetNavigate({ page: "fleet" })}
            />
            <ViewTab
              label="Topology"
              active={inFleet && fleetView?.page === "topology"}
              onClick={() => fleetNavigate({ page: "topology" })}
            />
          </nav>
          {!inFleet && (
            <SparkTabs
              sparks={tabSparks}
              activeId={displayActive?.id ?? activeId}
              onSelect={goSpark}
              onAdd={() => setShowAdd(true)}
              onEdit={(id) => setEditId(id)}
              onReorder={handleReorder}
            />
          )}
          <div className="ml-auto flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => setShowSettings(true)}
              className="icon-circle"
              title="Settings"
              aria-label="Settings"
            >
              <GearIcon className="h-4 w-4" />
            </button>
            <ThemeSwitch />
          </div>
        </header>
        <ConnectionBanner
          connected={connected}
          lastValidSnapshotAt={lastValidSnapshotAt}
          snapshotError={snapshotError}
          now={telemetryNow}
          stale={telemetryStale}
        />
        <ErrorBanner message={actionError} onDismiss={() => setActionError(null)} />
        <main className={telemetryStale || !connected ? "telemetry-stale" : undefined}>
          {inFleet && fleetView ? (
            <FleetViewPane
              view={fleetView}
              fleet={fleet}
              fleetError={fleetError}
              onNavigate={fleetNavigate}
              onActionError={(msg) => setActionError(msg)}
            />
          ) : isOverview ? (
            <OverviewPage
              sparks={displaySparks}
              hideOffline={settings?.autoHideOffline ?? false}
              hideWorkers={hideWorkers}
              showFleetEnergy={settings?.showFleetEnergy ?? false}
              showFleetExceptions={settings?.showFleetExceptions ?? false}
              showOverviewSearch={settings?.showOverviewSearch ?? false}
              temperatureUnit={settings?.temperatureUnit ?? "celsius"}
              onSelectSpark={goSpark}
            />
          ) : displayActive ? (
            <SparkPage
              spark={displayActive}
              temperatureUnit={settings?.temperatureUnit ?? "celsius"}
              benchShareImage={settings?.benchShareImage ?? false}
              onEdit={() => setEditId(displayActive.id)}
            />
          ) : (
            <div className="panel mx-auto mt-16 max-w-md p-8 text-center">
              <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-accent-soft text-accent">
                <span className="text-lg leading-none">+</span>
              </div>
              <h2 className="text-sm font-semibold text-text-strong">No Spark registered</h2>
              <p className="mt-1 text-xs text-muted">
                Click the&nbsp;
                <span className="rounded border border-border bg-surface-elevated px-1 py-0.5 text-text">+</span>
                &nbsp;tab to add a DGX Spark unit.
              </p>
            </div>
          )}
        </main>
      </div>
      <HermesUpdateDialog />
      <AddSparkDialog
        open={showAdd}
        onClose={() => setShowAdd(false)}
        onAdded={() => {
          void refreshFromApi();
        }}
        defaultLlmPort={settings?.defaultLlmPort ?? 8888}
      />
      <EditSparkDialog
        open={editId != null}
        sparkId={editId}
        onClose={() => setEditId(null)}
        onSaved={() => {
          void refreshFromApi();
        }}
        onDeleted={(id) => {
          if (activeId === id) {
            const next = displaySparks.find((s) => s.id !== id);
            goSpark(next?.id ?? OVERVIEW_ID);
          }
          void refreshFromApi();
        }}
      />
      <SettingsDialog
        open={showSettings}
        onClose={() => setShowSettings(false)}
        onSaved={handleSettingsSaved}
      />
    </div>
  );
}

/** Header view tab (Sparks / Fleet / Topology). */
function ViewTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
        active ? "bg-accent-soft text-accent" : "text-muted hover:text-text"
      }`}
    >
      {label}
    </button>
  );
}

/** Per-node sub-tab (Detail / Services / Requests) shown in the node views. */
function NodeSubTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
        active ? "bg-accent-soft text-accent" : "text-muted hover:text-text"
      }`}
    >
      {label}
    </button>
  );
}

function nodeRoleInfo(
  fleet: FleetSnapshot,
  nodeId: string
): { role: NodeRole; rank: number | null; groupId: string | null } {
  const topo = fleet.topology.nodes.find((t) => t.nodeId === nodeId);
  const snap = fleet.nodes.find((n) => n.nodeId === nodeId);
  const info = topo ?? snap?.topology;
  return {
    role: (info?.role ?? "standalone") as NodeRole,
    rank: info?.rank ?? null,
    groupId: info?.groupId ?? null,
  };
}

function EmptyNodePane({ title, detail, onBack, backLabel = "Back to fleet overview" }: {
  title: string;
  detail: string;
  onBack: () => void;
  backLabel?: string;
}) {
  return (
    <div className="panel mx-auto mt-16 max-w-md p-8 text-center">
      <h2 className="text-sm font-semibold text-text-strong">{title}</h2>
      <p className="mt-1 text-xs text-muted">{detail}</p>
      <button type="button" onClick={onBack} className="mt-4 text-xs text-accent underline">
        {backLabel}
      </button>
    </div>
  );
}

/**
 * Renders the fleet views (overview / topology / node detail / services /
 * requests) driven by useFleetRoute + useFleetData. All data comes from
 * GET /api/fleet (polling); the spark WS feed is untouched.
 */
function FleetViewPane({
  view,
  fleet,
  fleetError,
  onNavigate,
  onActionError,
}: {
  view: FleetView;
  fleet: FleetSnapshot | null;
  fleetError: string | null;
  onNavigate: (v: FleetView | null) => void;
  onActionError: (msg: string) => void;
}) {
  if (!fleet) {
    return (
      <div className="panel mx-auto mt-16 max-w-md p-8 text-center">
        <h2 className="text-sm font-semibold text-text-strong">Loading fleet…</h2>
        <p className="mt-1 text-xs text-muted">
          {fleetError ? `Fleet API error: ${fleetError}` : "Contacting node agents…"}
        </p>
      </div>
    );
  }

  if (view.page === "fleet") {
    return (
      <FleetPage
        nodes={fleet.nodes}
        topology={fleet.topology}
        requests={fleet.requests}
        memory={fleet.memory}
        onSelectNode={(nodeId) => onNavigate({ page: "node", nodeId })}
      />
    );
  }

  if (view.page === "topology") {
    return <TopologyPage nodes={fleet.topology.nodes} links={fleet.topology.links} />;
  }

  const node = fleet.nodes.find((n) => n.nodeId === view.nodeId) ?? null;
  if (!node) {
    return (
      <EmptyNodePane
        title="Node not found"
        detail={`No node with id “${view.nodeId}” in the fleet registry.`}
        onBack={() => onNavigate({ page: "fleet" })}
      />
    );
  }

  const roleInfo = nodeRoleInfo(fleet, node.nodeId);
  const subNav = (
    <div className="flex items-center gap-1">
      <NodeSubTab
        label="Detail"
        active={view.page === "node"}
        onClick={() => onNavigate({ page: "node", nodeId: node.nodeId })}
      />
      <NodeSubTab
        label="Services"
        active={view.page === "node-services"}
        onClick={() => onNavigate({ page: "node-services", nodeId: node.nodeId })}
      />
      <NodeSubTab
        label="Requests"
        active={view.page === "node-requests"}
        onClick={() => onNavigate({ page: "node-requests", nodeId: node.nodeId })}
      />
    </div>
  );

  if (view.page === "node") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--density-page-gap)" }}>
        {subNav}
        <NodeDetail
          nodeId={node.nodeId}
          nodeName={node.nodeName}
          lanIp={node.lanIp}
          role={roleInfo.role}
          rank={roleInfo.rank}
          groupId={roleInfo.groupId}
          online={node.online}
          gpu={node.gpu}
          cpu={node.cpu}
          mem={node.mem}
          disk={node.disk}
          net={node.net}
          containers={node.containers}
          services={node.services}
          versions={node.versions}
          requests={node.requests}
          topology={node.topology}
          memory={node.memory}
          polledAt={node.polledAt}
        />
      </div>
    );
  }

  if (view.page === "node-services") {
    const runAction = async (type: "start" | "stop" | "switch", serviceName: string) => {
      try {
        await sendNodeAction(node.nodeId, { type, serviceName });
      } catch (err) {
        onActionError(
          `Action ${type} on ${serviceName} failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    };
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--density-page-gap)" }}>
        {subNav}
        {node.memory ? (
          <ServiceManagerPage
            nodeId={node.nodeId}
            nodeName={node.nodeName}
            services={node.services}
            memory={node.memory}
            versions={node.versions}
            onStart={(serviceName) => void runAction("start", serviceName)}
            onStop={(serviceName) => void runAction("stop", serviceName)}
            onSwitch={(serviceName) => void runAction("switch", serviceName)}
          />
        ) : (
          <EmptyNodePane
            title="Memory budget unavailable"
            detail="The node agent has not reported a memory budget yet."
            onBack={() => onNavigate({ page: "fleet" })}
          />
        )}
      </div>
    );
  }

  // node-requests
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--density-page-gap)" }}>
      {subNav}
      {node.requests ? (
        <RequestsPage
          nodeId={node.nodeId}
          nodeName={node.nodeName}
          requests={node.requests}
          byModel={fleet.requests.byModel}
          byEngine={fleet.requests.byEngine}
          byMachine={fleet.requests.byMachine}
        />
      ) : (
        <EmptyNodePane
          title="No request stats"
          detail="This node has not reported request stats yet."
          onBack={() => onNavigate({ page: "fleet" })}
        />
      )}
    </div>
  );
}

function App() {
  const route = useAppRoute();
  if (route.mode === "showcase" && route.showcaseSparkId) {
    return <ShowcasePage sparkId={route.showcaseSparkId} />;
  }
  return <DashboardApp />;
}

export default App;
