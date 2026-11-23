import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, onAuthChange, invalidate } from './api';
import type { MethodOutput } from '../../main/ipc/registry';
import type { LookupListKey, Permission } from '../../shared/constants';

type AuthState = MethodOutput<'auth.state'>;
type Lookup = MethodOutput<'lookups.list'>[number];

interface SessionCtx {
  state: AuthState | null;
  refresh: () => Promise<void>;
  isOwner: boolean;
  can: (p: Permission) => boolean;
  lookups: Lookup[];
  lookup: (k: LookupListKey) => string[];
  reloadLookups: () => void;
  users: { id: string; displayName: string; role: string }[];
}

const Ctx = createContext<SessionCtx | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState | null>(null);
  const [lookups, setLookups] = useState<Lookup[]>([]);
  const [users, setUsers] = useState<{ id: string; displayName: string; role: string }[]>([]);
  const refresh = useCallback(async () => {
    try {
      setState(await api('auth.state', {}));
    } catch {
      setState((s) => s);
    }
  }, []);
  const reloadLookups = useCallback(() => {
    api('lookups.list', {}).then(setLookups, () => undefined);
    api('users.assignable', {}).then(setUsers, () => undefined);
  }, []);
  useEffect(() => {
    void refresh();
    const off = onAuthChange(() => void refresh());
    const offLock = window.lawApi.on('session:locked', () => void refresh());
    return () => {
      off();
      offLock();
    };
  }, [refresh]);
  const loggedIn = !!state?.user && !state.locked;
  useEffect(() => {
    if (loggedIn) {
      reloadLookups();
      invalidate();
    }
  }, [loggedIn, reloadLookups]);
  const value = useMemo<SessionCtx>(() => {
    const u = state?.user;
    return {
      state,
      refresh,
      isOwner: u?.role === 'owner',
      can: (p) => u?.role === 'owner' || (!!u && (u.permissions as string[]).includes(p)),
      lookups,
      lookup: (k) => lookups.filter((l) => l.list_key === k && l.active).map((l) => l.label),
      reloadLookups,
      users,
    };
  }, [state, refresh, lookups, reloadLookups, users]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('SessionProvider missing');
  return c;
}
