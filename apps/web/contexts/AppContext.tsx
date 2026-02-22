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

// ── localStorage helpers ──────────────────────────────────────────────────────

function throwsCacheKey(address: string) {
  return `eden-throws-${address}`;
}

function loadCachedThrows(address: string): UnifiedThrow[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(throwsCacheKey(address));
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveCachedThrows(address: string, throws: UnifiedThrow[]) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(throwsCacheKey(address), JSON.stringify(throws));
  } catch {}
}

function pendingKey(address: string) {
  return `eden-pending-${address}`;
}

function loadPendingThrows(address: string): UnifiedThrow[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(pendingKey(address));
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function savePendingThrows(address: string, throws: UnifiedThrow[]) {
  if (typeof window === "undefined") return;
  try {
    if (throws.length === 0) localStorage.removeItem(pendingKey(address));
    else localStorage.setItem(pendingKey(address), JSON.stringify(throws));
  } catch {}
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function AppProvider({ children }: { children: ReactNode }) {
  const { address } = useWallet();

  const [confirmedThrows, setConfirmedThrows] = useState<UnifiedThrow[]>([]);
  const [pendingThrows, setPendingThrows] = useState<UnifiedThrow[]>([]);
  const [throwsLoading, setThrowsLoading] = useState(false);
  const [throwsError, setThrowsError] = useState<string | null>(null);
  const [onChainHarvests, setOnChainHarvests] = useState<OnChainHarvest[]>([]);
  const [local, setLocal] = useState<LocalState>({ observations: [], harvests: [], notifications: [] });

  const isFetching = useRef(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // ── local state ────────────────────────────────────────────────────────────

  const reload = useCallback(() => {
    setLocal(loadLocal());
  }, []);

  useEffect(() => {
    reload();
    const t = setInterval(reload, 30_000);
    return () => clearInterval(t);
  }, [reload]);

  // ── on address change: load from cache immediately ─────────────────────────

  useEffect(() => {
    if (!address) {
      setConfirmedThrows([]);
      setPendingThrows([]);
      setOnChainHarvests([]);
      stopPolling();
      return;
    }

    // Instantly show cached throws (so UI is populated before fetch completes)
    const cached = loadCachedThrows(address);
    if (cached.length > 0) {
      setConfirmedThrows(cached);
    }

    // Also restore any pending throws for this address
    const pending = loadPendingThrows(address);
    setPendingThrows(pending);

    // Then fetch fresh from chain in background
    doFetch(address);

    // If there were pending throws, start polling
    if (pending.length > 0) {
      startPolling(address);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  // ── fetch from chain ───────────────────────────────────────────────────────

  const doFetch = useCallback(async (addr: string) => {
    if (isFetching.current) return;
    isFetching.current = true;

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

      // Save to cache so next login is instant
      saveCachedThrows(addr, unified);
      setConfirmedThrows(unified);
      setOnChainHarvests(harvests);

      // Clear any pending throws that are now confirmed
      if (unified.length > 0) {
        setPendingThrows((prev) => {
          const confirmedAsaIds = new Set(unified.map((t) => t.asaId));
          const stillPending = prev.filter(
            (p) => p.asaId === 0 || !confirmedAsaIds.has(p.asaId)
          );
          savePendingThrows(addr, stillPending);
          return stillPending;
        });
      }

      // Seed notifications
      for (const t of unified) {
        seedNotifications(`chain-${t.asaId}`, t.throwDate, t.growthModelId);
      }
      reload();
    } catch (e) {
      if (mountedRef.current) {
        setThrowsError(e instanceof Error ? e.message : "Fetch failed");
      }
    } finally {
      isFetching.current = false;
    }
  }, [reload]);

  const refreshThrows = useCallback(async () => {
    if (!address) return;
    setThrowsLoading(true);
    setThrowsError(null);
    try {
      await doFetch(address);
    } finally {
      if (mountedRef.current) setThrowsLoading(false);
    }
  }, [address, doFetch]);

  // ── polling ────────────────────────────────────────────────────────────────

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPolling = useCallback((addr: string) => {
    stopPolling();
    let ticks = 0;

    pollRef.current = setInterval(async () => {
      ticks++;

      // Stop after 24 ticks = 2 minutes
      if (ticks > 24) {
        stopPolling();
        // Clear pending regardless — don't leave spinner forever
        setPendingThrows([]);
        savePendingThrows(addr, []);
        return;
      }

      try {
        const fetched = await fetchThrowsForAddress(addr);
        if (!mountedRef.current) return;

        if (fetched.length > 0) {
          const unified: UnifiedThrow[] = fetched.map((t) => ({
            ...t,
            localId: `chain-${t.asaId}`,
            isPending: false,
          }));

          saveCachedThrows(addr, unified);
          setConfirmedThrows(unified);

          // Clear ALL pending — they're confirmed
          setPendingThrows([]);
          savePendingThrows(addr, []);
          stopPolling();

          // Seed notifications
          for (const t of unified) {
            seedNotifications(`chain-${t.asaId}`, t.throwDate, t.growthModelId);
          }
          reload();
        }
      } catch {
        // keep polling
      }
    }, 5000);
  }, [stopPolling, reload]);

  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  // ── add pending throw ──────────────────────────────────────────────────────

  const addPendingThrow = useCallback((t: UnifiedThrow) => {
    if (!address) return;
    const withFlag = { ...t, isPending: true };
    setPendingThrows((prev) => {
      const next = [withFlag, ...prev];
      savePendingThrows(address, next);
      return next;
    });
    startPolling(address);
  }, [address, startPolling]);

  // ── observations / harvests ────────────────────────────────────────────────

  const addObservation = useCallback((data: Omit<Observation, "id" | "observedAt">) => {
    storeAddObs(data);
    reload();
  }, [reload]);

  const addLocalHarvest = useCallback((data: Omit<Harvest, "id" | "harvestedAt">) => {
    storeAddHarvest(data);
    reload();
  }, [reload]);

  const markRead = useCallback((id: string) => {
    storeMark(id);
    reload();
  }, [reload]);

  const markAllReadFn = useCallback(() => {
    storeMarkAll();
    reload();
  }, [reload]);

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
