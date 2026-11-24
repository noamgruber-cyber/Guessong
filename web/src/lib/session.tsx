import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AppConfig, UserDTO } from '@guessong/shared';
import { api } from '../api';

interface Toast {
  id: number;
  text: string;
  tone: 'default' | 'error' | 'success';
}

interface SessionValue {
  user: UserDTO | null;
  config: AppConfig | null;
  ready: boolean;
  error: string | null;
  setUser(u: UserDTO): void;
  refresh(): Promise<void>;
  /** Ensures a (guest) session exists and returns its user. */
  ensureUser(): Promise<UserDTO>;
  toast(text: string, tone?: Toast['tone']): void;
  providerLabel: string;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserDTO | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const ensuring = useRef<Promise<UserDTO> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const me = await api.me();
      setConfig(me.config);
      setUser(me.user);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReady(true);
    }
  }, []);

  const ensureUser = useCallback(async () => {
    if (user) return user;
    if (!ensuring.current) {
      ensuring.current = api.guest().then((r) => {
        setUser(r.user);
        return r.user;
      });
      ensuring.current.finally(() => (ensuring.current = null));
    }
    return ensuring.current;
  }, [user]);

  const toast = useCallback((text: string, tone: Toast['tone'] = 'default') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Everyone gets an anonymous guest session so scores can be saved.
  useEffect(() => {
    if (ready && config && !user && !error) void ensureUser().catch(() => {});
  }, [ready, config, user, error, ensureUser]);

  const value = useMemo<SessionValue>(
    () => ({
      user,
      config,
      ready,
      error,
      setUser,
      refresh,
      ensureUser,
      toast,
      providerLabel: config?.providerLabel ?? 'Music',
    }),
    [user, config, ready, error, refresh, ensureUser, toast],
  );

  return (
    <SessionContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            {t.text}
          </div>
        ))}
      </div>
    </SessionContext.Provider>
  );
}

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}

/** In Spotify mode, playing needs a connected Premium account. */
export function needsSpotifyConnect(config: AppConfig | null, user: UserDTO | null): boolean {
  return !!config?.requiresSpotifyLogin && !user?.spotifyConnected;
}
