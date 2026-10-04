import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, type Me } from './api';

interface AuthCtx {
  me: Me | null;
  loading: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  unread: number;
  refreshUnread: () => Promise<void>;
}

const Ctx = createContext<AuthCtx>(null as unknown as AuthCtx);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [unread, setUnread] = useState(0);

  const refresh = useCallback(async () => {
    try {
      setMe(await api.get<Me>('/auth/me'));
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshUnread = useCallback(async () => {
    try {
      const r = await api.get<{ unread: number }>('/notifications');
      setUnread(r.unread);
    } catch {
      /* signed out */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (me?.user && !me.user.mfa_enrol_required) void refreshUnread();
  }, [me?.user?.id, me?.user?.mfa_enrol_required, refreshUnread]);

  const signOut = useCallback(async () => {
    await api.post('/auth/logout');
    setMe((m) => (m ? { ...m, user: null } : m));
    setUnread(0);
  }, []);

  return <Ctx.Provider value={{ me, loading, refresh, signOut, unread, refreshUnread }}>{children}</Ctx.Provider>;
}
