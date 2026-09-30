import { useEffect, useState } from "react";
import { fetchFleet } from "../api/client";
import type { FleetSnapshot } from "../api/types";

/**
 * useFleetData — polls GET /api/fleet while `enabled` is true.
 *
 * Graceful degradation: on a failed poll the last good snapshot is kept and
 * only `error` is updated, so the fleet pages never blank out over a
 * transient network blip (mirrors useSnapshot's stale-data behavior).
 */
export function useFleetData(enabled: boolean, intervalMs = 3000) {
  const [snapshot, setSnapshot] = useState<FleetSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const load = async () => {
      try {
        const data = await fetchFleet();
        if (cancelled) return;
        setSnapshot(data);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      }
    };

    void load();
    const timer = window.setInterval(load, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled, intervalMs]);

  return { snapshot, error };
}
