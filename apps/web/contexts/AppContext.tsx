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
  createdAt?: number; // timestamp ms — used to age-out pending
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
    // Always force isPending false on confirmed cache
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
    // Age out pending throws older than 3 minutes — indexer must have them by now
    const cutoff = Date.now() - 3 * 60 * 1000;
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

  // ── polling control ────────────────────────────────────────────────────────

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  // ── clear pending throws that are aged out ─────────────────────────────────

  const clearAgedPending = useCallback((addr: string) => {
    setPendingThrows((prev) => {
      const cutoff = Date.now() - 3 * 60 * 1000;
      const fresh = prev.filter((t) => t.createdAt && t.createdAt > cutoff);
      if (fresh.length !== prev.length) {
        savePending(addr, fresh);
      }
      return fresh;
    });
  }, []);

  // ── fetch from chain ───────────────────────────────────────────────────────

  const doFetch = useCallback(async (addr: string) => {
    console.log("[AppContext] doFetch start", addr);
    try {
      const [fetched, harvests] = await Promise.all([
        fetchThrowsForAddress(addr),
        fetchHarvestsForAddress(addr),
      ]);

      if (!mountedRef.current) return;

      const unified: UnifiedThrow[] = fetched.map((t) => ({
        ...t,
        localId: `chain-${t.asaId}`,
        isPending: false,
      }));

      console.log("[AppContext] doFetch got", unified.length, "confirmed throws");

      saveConfirmed(addr, unified);
      setConfirmedThrows(unified);
      setOnChainHarvests(harvests);
      setThrowsError(null);

      // Clear pending that are now confirmed
      setPendingThrows((prev) => {
        if (prev.length === 0) return prev;
        const confirmedAsaIds = new Set(unified.map((t) => t.asaId));
        // If we got MORE confirmed than before, clear all pending
        const stillPending = unified.length > 0
          ? prev.filter((p) => p.asaId === 0 || !confirmedAsaIds.has(p.asaId))
          : prev;
        savePending(addr, stillPending);
        if (stillPending.length === 0) stopPolling();
        return stillPending;
      });

      for (const t of unified) {
        seedNotifications(`chain-${t.asaId}`, t.throwDate, t.growthModelId);
      }
      reload();
    } catch (e) {
      console.warn("[AppContext] doFetch error:", e);
      if (mountedRef.current) {
        const msg = e instanceof Error ? e.message : "Fetch failed";
        setThrowsError(msg);
      }
      // Even if fetch fails, age out old pending throws
      clearAgedPending(addr);
    }
  }, [reload, stopPolling, clearAgedPending]);

  // ── start polling ──────────────────────────────────────────────────────────

  const startPolling = useCallback((addr: string) => {
    stopPolling();
    let ticks = 0;

    pollRef.current = setInterval(async () => {
      ticks++;
      console.log("[AppContext] poll tick", ticks);

      // Hard stop at 36 ticks = 3 minutes
      if (ticks > 36) {
        console.log("[AppContext] poll hard stop — clearing pending");
        stopPolling();
        setPendingThrows([]);
        savePending(addr, []);
        return;
      }

      // Also clear aged pending on every tick
      clearAgedPending(addr);

      await doFetch(addr);
    }, 5000);
  }, [stopPolling, doFetch, clearAgedPending]);

  // ── react to wallet address change ─────────────────────────────────────────

  useEffect(() => {
    if (!address) {
      setConfirmedThrows([]);
      setPendingThrows([]);
      setOnChainHarvests([]);
      setThrowsError(null);
      stopPolling();
      return;
    }

    // Load confirmed cache first — instantly shows throws with isPending: false
    const cached = loadConfirmed(address);
    console.log("[AppContext] loaded", cached.length, "cached confirmed throws");
    setConfirmedThrows(cached);

    // Load pending — age-filtered, so old ones are gone
    const pending = loadPending(address);
    console.log("[AppContext] loaded", pending.length, "pending throws");
    setPendingThrows(pending);

    // Fetch fresh from chain
    doFetch(address);

    // Resume polling if there are pending throws
    if (pending.length > 0) {
      startPolling(address);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  // ── manual refresh ─────────────────────────────────────────────────────────

  const refreshThrows = useCallback(async () => {
    if (!address) return;
    setThrowsLoading(true);
    try {
      await doFetch(address);
    } finally {
      if (mountedRef.current) setThrowsLoading(false);
    }
  }, [address, doFetch]);

  // ── add pending throw ──────────────────────────────────────────────────────

  const addPendingThrow = useCallback((t: UnifiedThrow) => {
    if (!address) return;
    const stamped = { ...t, isPending: true, createdAt: Date.now() };
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

  // ── merge throws ───────────────────────────────────────────────────────────

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
