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

// ── cache helpers — CONFIRMED throws only, never pending ──────────────────────

function cacheKey(address: string) {
  return `eden-confirmed-${address}`;
}

function loadConfirmedCache(address: string): UnifiedThrow[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(cacheKey(address));
    if (!raw) return [];
    // Always strip isPending when reading from cache
    const parsed: UnifiedThrow[] = JSON.parse(raw);
    return parsed.map((t) => ({ ...t, isPending: false }));
  } catch {
    return [];
  }
}

function saveConfirmedCache(address: string, throws: UnifiedThrow[]) {
  if (typeof window === "undefined") return;
  try {
    // Never save pending throws to confirmed cache
    const confirmed = throws
      .filter((t) => !t.isPending && t.asaId > 0)
      .map((t) => ({ ...t, isPending: false }));
    localStorage.setItem(cacheKey(address), JSON.stringify(confirmed));
  } catch {}
}

// ── pending helpers — separate key, wiped on confirm ─────────────────────────

function pendingKey(address: string) {
  return `eden-pending-${address}`;
}

function loadPendingCache(address: string): UnifiedThrow[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(pendingKey(address));
    if (!raw) return [];
    const parsed: UnifiedThrow[] = JSON.parse(raw);
    return parsed.map((t) => ({ ...t, isPending: true }));
  } catch {
    return [];
  }
}

function savePendingCache(address: string, throws: UnifiedThrow[]) {
  if (typeof window === "undefined") return;
  try {
    if (throws.length === 0) {
      localStorage.removeItem(pendingKey(address));
    } else {
      localStorage.setItem(pendingKey(address), JSON.stringify(throws));
    }
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
    observations: [],
    harvests: [],
    notifications: [],
  });

  const isFetching = useRef(false);
  const pollRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // ── local storage reload ───────────────────────────────────────────────────

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

  // ── core fetch from chain ──────────────────────────────────────────────────

  const doFetch = useCallback(async (addr: string): Promise<UnifiedThrow[]> => {
    const [fetched, harvests] = await Promise.all([
      fetchThrowsForAddress(addr),
      fetchHarvestsForAddress(addr),
    ]);

    const unified: UnifiedThrow[] = fetched.map((t) => ({
      ...t,
      localId: `chain-${t.asaId}`,
      isPending: false, // always false for chain data
    }));

    if (!mountedRef.current) return unified;

    // Save confirmed cache — no pending items ever go here
    saveConfirmedCache(addr, unified);
    setConfirmedThrows(unified);
    setOnChainHarvests(harvests);

    // Remove any pending throws that are now confirmed on chain
    setPendingThrows((prev) => {
      const confirmedAsaIds = new Set(unified.map((t) => t.asaId));
      const stillPending = prev.filter(
        (p) => p.asaId === 0 || !confirmedAsaIds.has(p.asaId)
      );
      savePendingCache(addr, stillPending);
      if (stillPending.length === 0) stopPolling();
      return stillPending;
    });

    // Seed notifications
    for (const t of unified) {
      seedNotifications(`chain-${t.asaId}`, t.throwDate, t.growthModelId);
    }
    reload();

    return unified;
  }, [reload, stopPolling]);

  // ── polling after a new throw ──────────────────────────────────────────────

  const startPolling = useCallback((addr: string) => {
    stopPolling();
    let ticks = 0;

    pollRef.current = setInterval(async () => {
      ticks++;

      // Hard stop after 24 ticks (2 minutes)
      if (ticks > 24) {
        stopPolling();
        // Force-clear pending so spinner never shows forever
        setPendingThrows([]);
        savePendingCache(addr, []);
        return;
      }

      try {
        await doFetch(addr);
        // doFetch clears pendingThrows and calls stopPolling if empty
      } catch {
        // keep polling — indexer may be briefly unavailable
      }
    }, 5000);
  }, [stopPolling, doFetch]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  // ── react to wallet connect / disconnect ───────────────────────────────────

  useEffect(() => {
    if (!address) {
      setConfirmedThrows([]);
      setPendingThrows([]);
      setOnChainHarvests([]);
      stopPolling();
      return;
    }

    // 1. Load confirmed cache immediately — these show right away, no spinner
    const cached = loadConfirmedCache(address);
    setConfirmedThrows(cached);

    // 2. Load pending cache — these show with confirming badge
    const pending = loadPendingCache(address);
    setPendingThrows(pending);

    // 3. Fetch fresh from chain in background (silent — no loading spinner
    //    since we already have cached data)
    isFetching.current = false;
    doFetch(address).catch((e) => {
      if (mountedRef.current) {
        setThrowsError(e instanceof Error ? e.message : "Fetch failed");
      }
    });

    // 4. If there were pending throws, resume polling
    if (pending.length > 0) {
      startPolling(address);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  // ── manual refresh ─────────────────────────────────────────────────────────

  const refreshThrows = useCallback(async () => {
    if (!address) return;
    setThrowsLoading(true);
    setThrowsError(null);
    try {
      await doFetch(address);
    } catch (e) {
      if (mountedRef.current) {
        setThrowsError(e instanceof Error ? e.message : "Fetch failed");
      }
    } finally {
      if (mountedRef.current) setThrowsLoading(false);
    }
  }, [address, doFetch]);

  // ── add pending throw ──────────────────────────────────────────────────────

  const addPendingThrow = useCallback((t: UnifiedThrow) => {
    if (!address) return;
    const pending = { ...t, isPending: true };
    setPendingThrows((prev) => {
      const next = [pending, ...prev];
      savePendingCache(address, next);
      return next;
    });
    startPolling(address);
  }, [address, startPolling]);

  // ── observations / harvests ────────────────────────────────────────────────

  const addObservation = useCallback(
    (data: Omit<Observation, "id" | "observedAt">) => {
      storeAddObs(data); reload();
    }, [reload]
  );

  const addLocalHarvest = useCallback(
    (data: Omit<Harvest, "id" | "harvestedAt">) => {
      storeAddHarvest(data); reload();
    }, [reload]
  );

  const markRead = useCallback((id: string) => { storeMark(id); reload(); }, [reload]);
  const markAllReadFn = useCallback(() => { storeMarkAll(); reload(); }, [reload]);

  // ── merge — pending first, then confirmed, deduped ────────────────────────

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
