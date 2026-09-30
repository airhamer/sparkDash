import { useEffect, useCallback, useRef, useState } from "react";
import { OVERVIEW_ID } from "../constants";

export type RouteMode = "app" | "showcase";
export interface AppRoute {
  mode: RouteMode;
  /** Spark id for showcase mode */
  showcaseSparkId: string | null;
}

function parsePath(pathname: string): AppRoute {
  const showcase = pathname.match(/^\/showcase\/([^/]+)/);
  if (showcase) {
    return {
      mode: "showcase",
      showcaseSparkId: decodeURIComponent(showcase[1]),
    };
  }
  return { mode: "app", showcaseSparkId: null };
}

/**
 * Parse the current URL for showcase vs normal app shell.
 * Call once at App root so showcase skips the dashboard chrome.
 */
export function useAppRoute(): AppRoute {
  const [route, setRoute] = useState(() => parsePath(window.location.pathname));

  useEffect(() => {
    const handler = () => setRoute(parsePath(window.location.pathname));
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  return route;
}

/**
 * useRoute — syncs the browser URL path with the active spark ID.
 *
 * URL scheme:
 *   /             → Overview
 *   /spark/:id    → Spark detail page
 *   /showcase/:id → full-screen showcase (handled separately via useAppRoute)
 *
 * Call `navigate(id)` to switch views — it updates both the URL and
 * the internal activeId state. Back/forward buttons work via popstate.
 */
export function useRoute(
  setActiveId: (id: string | null) => void
): (id: string | null) => void {
  // Read initial activeId from the URL on mount
  const initialised = useRef(false);

  useEffect(() => {
    if (initialised.current) return;
    initialised.current = true;

    const path = window.location.pathname;
    if (path.startsWith("/showcase/")) return;

    const match = path.match(/^\/spark\/([^/]+)/);
    if (match) {
      setActiveId(match[1]);
    } else if (path !== "/spark") {
      setActiveId(OVERVIEW_ID);
    }
  }, [setActiveId]);

  // Sync back/forward navigation
  useEffect(() => {
    const handler = () => {
      const path = window.location.pathname;
      if (path.startsWith("/showcase/")) return;
      const match = path.match(/^\/spark\/([^/]+)/);
      setActiveId(match ? match[1] : OVERVIEW_ID);
    };
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, [setActiveId]);

  // Wrapped navigate function — updates URL + internal state
  const navigate = useCallback(
    (id: string | null) => {
      const url = id && id !== OVERVIEW_ID ? `/spark/${encodeURIComponent(id)}` : "/";
      window.history.pushState(null, "", url);
      setActiveId(id);
    },
    [setActiveId]
  );

  return navigate;
}

// ─── Fleet views (node-agent layer) ────────────────────────────────────────
//
// URL scheme (independent of the spark tab bar):
//   /fleet                → fleet overview
//   /topology             → topology / RoCE diagram
//   /node/:id             → node detail
//   /node/:id/services    → service manager (start/stop/switch)
//   /node/:id/requests    → requests visualization

export type FleetView =
  | { page: "fleet" }
  | { page: "topology" }
  | { page: "node"; nodeId: string }
  | { page: "node-services"; nodeId: string }
  | { page: "node-requests"; nodeId: string };

export function fleetViewToPath(v: FleetView): string {
  switch (v.page) {
    case "fleet":
      return "/fleet";
    case "topology":
      return "/topology";
    case "node":
      return `/node/${encodeURIComponent(v.nodeId)}`;
    case "node-services":
      return `/node/${encodeURIComponent(v.nodeId)}/services`;
    case "node-requests":
      return `/node/${encodeURIComponent(v.nodeId)}/requests`;
  }
}

export function parseFleetPath(pathname: string): FleetView | null {
  if (pathname === "/fleet") return { page: "fleet" };
  if (pathname === "/topology") return { page: "topology" };
  const m = pathname.match(/^\/node\/([^/]+)(?:\/(services|requests))?$/);
  if (!m) return null;
  const nodeId = decodeURIComponent(m[1]);
  if (m[2] === "services") return { page: "node-services", nodeId };
  if (m[2] === "requests") return { page: "node-requests", nodeId };
  return { page: "node", nodeId };
}

/**
 * useFleetRoute — router for the fleet views. `view: null` means the user is
 * NOT in a fleet view (spark overview / spark detail instead). Back/forward
 * work via popstate, like useRoute.
 *
 * `navigate(null)` leaves the fleet views using history.replaceState so the
 * URL is cleaned without stacking a redundant "/" entry.
 */
export function useFleetRoute() {
  const [view, setView] = useState<FleetView | null>(() =>
    parseFleetPath(window.location.pathname)
  );

  useEffect(() => {
    const handler = () => setView(parseFleetPath(window.location.pathname));
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  const navigate = useCallback((v: FleetView | null) => {
    if (v == null) {
      window.history.replaceState(null, "/");
      setView(null);
      return;
    }
    window.history.pushState(null, "/", fleetViewToPath(v));
    setView(v);
  }, []);

  return { view, navigate };
}
