"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
  ReactNode,
} from "react";
import {
  LocalState,
  Observation,
  Harvest,
  Notification,
  loadLocal,
  addObservation as storeAddObs,
  addLocalHarvest as storeAddHarvest,
  markNotificationRead as storeMark,
  markAllRead as storeMarkAll,
  getDueNotifications,
  seedNotifications,
} from "@/lib/store";
import {
  OnChainThrow,
  OnChainHarvest,
  fetchThrowsForAddress,
  fetchHarvestsForAddress,
} from "@/lib/algorand";
import { useWallet } from "@/contexts/WalletContext";

export interface UnifiedThrow extends OnChainThrow {
  localId: string;
  isPending?: boolean;
  createdAt?: number;
}

interface AppCtxType {
  userName: string;
  throws: UnifiedThrow[];
  throwsLoading: boolean;
  throwsError: string | null;
  refreshThrows: () => Promise<void>;
  addPendingThrow: (t: UnifiedThrow) => void;
  observations: Observation[];
  addObservation: (data: Omit<Observation, "id" | "observedAt">) => void;
  onChainHarvests: OnChainHarvest[];
  localHarvests: Harvest[];
  addLocalHarvest: (data: Omit<Harvest, "id" | "harvestedAt">) => void;
  notifications: Notification[];
  unreadCount: number;
  markRead: (id: string) => void;
  markAllRead: () => void;
  reload: () => void;
}

const AppCtx = createContext<AppCtxType | null>(null);

// ── localStorage helpers ──────────────────────────────────────────────────────

function confirmedKey(address: string) {
  return `eden-confirmed-v3-${address}`;
}
function pendingKey(address: string) {
  return `eden-pending-v3-${address}`;
}

function loadConfirmed(address: string): UnifiedThrow[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(confirmedKey(address));
    if (!raw) return [];
    const parsed: UnifiedThrow[] = JSON.parse(raw);
    return parsed.map((t) => ({ ...t, isPending: false }));
  } catch { return []; }
}

function saveConfirmed(address: string, throws: UnifiedThrow[]) {
  if (typeof window === "undefined") return;
  try {
    const clean = throws
      .filter((t) => t.asaId > 0)
      .map((t) => ({ ...t, isPending: false }));
    localStorage.setItem(confirmedKey(address), JSON.stringify(clean));
  } catch {}
}

function loadPending(address: string): UnifiedThrow[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(pendingKey(address));
    if (!raw) return [];
    const parsed: UnifiedThrow[] = JSON.parse(raw);
    // Age out anything older than 5 minutes — definitely indexed by then
    const cutoff = Date.now() - 5 * 60 * 1000;
    return parsed
      .filter((t) => !t.createdAt || t.createdAt > cutoff)
      .map((t) => ({ ...t, isPending: true }));
  } catch { return []; }
}

function savePending(address: string, throws: UnifiedThrow[]) {
  if (typeof window === "undefined") return;
  try {
    if (throws.length === 0) localStorage.removeItem(pendingKey(address));
    else localStorage.setItem(pendingKey(address), JSON.stringify(throws));
  } catch {}
}

// ── provider ──────────────────────────────────────────────────────────────────

export function AppProvider({ children }: { children: ReactNode }) {
  const { address } = useWallet();

  const [confirmedThrows, setConfirmedThrows] = useState<UnifiedThrow[]>([]);
  const [pendingThrows, setPendingThrows]     = useState<UnifiedThrow[]>([]);
  const [throwsLoading, setThrowsLoading]     = useState(false);
  const [throwsError, setThrowsError]         = useState<string | null>(null);
  const [onChainHarvests, setOnChainHarvests] = useState<OnChainHarvest[]>([]);
  const [local, setLocal] = useState<LocalState>({
    observations: [], harvests: [], notifications: [],
  });

  const pollRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);
  // Track how many confirmed throws existed before latest pending throw was added
  const confirmedCountAtMint = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const reload = useCallback(() => setLocal(loadLocal()), []);

  useEffect(() => {
    reload();
    const t = setInterval(reload, 30_000);
    return () => clearInterval(t);
  }, [reload]);

  // ── stop polling ───────────────────────────────────────────────────────────

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  // ── core fetch ─────────────────────────────────────────────────────────────

  const doFetch = useCallback(async (addr: string): Promise<UnifiedThrow[]> => {
    const [fetched, harvests] = await Promise.all([
      fetchThrowsForAddress(addr),
      fetchHarvestsForAddress(addr),
    ]);

    if (!mountedRef.current) return [];

    const unified: UnifiedThrow[] = fetched.map((t) => ({
      ...t,
      localId: `chain-${t.asaId}`,
      isPending: false,
    }));

    saveConfirmed(addr, unified);
    setConfirmedThrows(unified);
    setOnChainHarvests(harvests);
    setThrowsError(null);

    // Only clear pending throws whose ASA IDs now appear in confirmed.
    // This means a newly minted throw stays in pending until IT specifically
    // shows up on chain — not just because older throws are already there.
    setPendingThrows((prev) => {
      if (prev.length === 0) return prev;

      const confirmedAsaIds = new Set(unified.map((t) => t.asaId));

      // A pending throw can be cleared if:
      // 1. Its actual asaId appears in confirmed (it got indexed), OR
      // 2. The total confirmed count is now greater than it was when
      //    the pending throw was created (new throw appeared)
      const newConfirmedCount = unified.length;

      const stillPending = prev.filter((p) => {
        // If we know its asaId and it's confirmed, clear it
        if (p.asaId > 0 && confirmedAsaIds.has(p.asaId)) return false;
        // If confirmed count grew past what it was when this was added, clear it
        if (newConfirmedCount > confirmedCountAtMint.current) return false;
        // Otherwise keep it pending
        return true;
      });

      if (stillPending.length !== prev.length) {
        savePending(addr, stillPending);
        if (stillPending.length === 0) stopPolling();
      }

      return stillPending;
    });

    for (const t of unified) {
      seedNotifications(`chain-${t.asaId}`, t.throwDate, t.growthModelId);
    }
    reload();

    return unified;
  }, [reload, stopPolling]);

  // ── polling ────────────────────────────────────────────────────────────────

  const startPolling = useCallback((addr: string) => {
    stopPolling();
    let ticks = 0;

    pollRef.current = setInterval(async () => {
      ticks++;
      console.log("[poll] tick", ticks);

      // Hard stop at 60 ticks = 5 minutes, clear pending regardless
      if (ticks > 60) {
        console.log("[poll] hard stop");
        stopPolling();
        setPendingThrows([]);
        savePending(addr, []);
        return;
      }

      try {
        await doFetch(addr);
      } catch (e) {
        console.warn("[poll] fetch error:", e);
      }
    }, 5000);
  }, [stopPolling, doFetch]);

  // ── wallet connect / disconnect ────────────────────────────────────────────

  useEffect(() => {
    if (!address) {
      setConfirmedThrows([]);
      setPendingThrows([]);
      setOnChainHarvests([]);
      setThrowsError(null);
      stopPolling();
      return;
    }

    // Show cached confirmed immediately — always isPending: false
    const cached = loadConfirmed(address);
    setConfirmedThrows(cached);
    confirmedCountAtMint.current = cached.length;

    // Restore pending (age-filtered)
    const pending = loadPending(address);
    setPendingThrows(pending);

    // Background fetch
    doFetch(address).catch((e) => {
      if (mountedRef.current)
        setThrowsError(e instanceof Error ? e.message : "Fetch failed");
    });

    // Resume polling if pending exist
    if (pending.length > 0) startPolling(address);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  // ── manual refresh ─────────────────────────────────────────────────────────

  const refreshThrows = useCallback(async () => {
    if (!address) return;
    setThrowsLoading(true);
    try {
      await doFetch(address);
    } catch (e) {
      if (mountedRef.current)
        setThrowsError(e instanceof Error ? e.message : "Fetch failed");
    } finally {
      if (mountedRef.current) setThrowsLoading(false);
    }
  }, [address, doFetch]);

  // ── add pending throw ──────────────────────────────────────────────────────

  const addPendingThrow = useCallback((t: UnifiedThrow) => {
    if (!address) return;

    // Record how many confirmed throws exist RIGHT NOW before this new mint
    setConfirmedThrows((current) => {
      confirmedCountAtMint.current = current.length;
      return current;
    });

    const stamped: UnifiedThrow = { ...t, isPending: true, createdAt: Date.now() };

    setPendingThrows((prev) => {
      const next = [stamped, ...prev];
      savePending(address, next);
      return next;
    });

    startPolling(address);
  }, [address, startPolling]);

  // ── observations / harvests ────────────────────────────────────────────────

  const addObservation = useCallback(
    (data: Omit<Observation, "id" | "observedAt">) => { storeAddObs(data); reload(); },
    [reload]
  );
  const addLocalHarvest = useCallback(
    (data: Omit<Harvest, "id" | "harvestedAt">) => { storeAddHarvest(data); reload(); },
    [reload]
  );
  const markRead = useCallback((id: string) => { storeMark(id); reload(); }, [reload]);
  const markAllReadFn = useCallback(() => { storeMarkAll(); reload(); }, [reload]);

  // ── merge: pending first then confirmed, deduped ──────────────────────────

  const confirmedAsaIds = new Set(confirmedThrows.map((t) => t.asaId));
  const filteredPending = pendingThrows.filter(
    (p) => p.asaId === 0 || !confirmedAsaIds.has(p.asaId)
  );
  const allThrows = [...filteredPending, ...confirmedThrows];

  const due = getDueNotifications(local.notifications);

  return (
    <AppCtx.Provider value={{
      userName: "",
      throws: allThrows,
      throwsLoading,
      throwsError,
      refreshThrows,
      addPendingThrow,
      observations: local.observations,
      addObservation,
      onChainHarvests,
      localHarvests: local.harvests,
      addLocalHarvest,
      notifications: local.notifications,
      unreadCount: due.length,
      markRead,
      markAllRead: markAllReadFn,
      reload,
    }}>
      {children}
    </AppCtx.Provider>
  );
}

export function useApp(): AppCtxType {
  const ctx = useContext(AppCtx);
  if (!ctx) throw new Error("useApp must be inside AppProvider");
  return ctx;
}
