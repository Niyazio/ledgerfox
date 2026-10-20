import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "./api";

export interface Me {
  user: { id: string; email: string; name: string } | null;
  organisations: { org_id: string; org_name: string; role: string }[];
  companies: { id: string; name: string; org_id: string; base_currency: string; country: string }[];
  brand: string;
}

interface SessionCtx {
  me: Me | null;
  loading: boolean;
  refresh: () => Promise<Me | null>;
  logout: () => Promise<void>;
}

const Ctx = createContext<SessionCtx | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      const r = await api.get<Me>("/api/auth/me");
      setMe(r);
      return r;
    } catch {
      setMe({ user: null, organisations: [], companies: [], brand: "Arthika" });
      return null;
    } finally {
      setLoading(false);
    }
  }, []);
  const logout = useCallback(async () => {
    await api.post("/api/auth/logout").catch(() => undefined);
    setMe({ user: null, organisations: [], companies: [], brand: me?.brand ?? "Arthika" });
  }, [me?.brand]);
  useEffect(() => {
    refresh();
    const onUnauth = () => setMe((m) => (m ? { ...m, user: null } : m));
    window.addEventListener("arthika:unauthorized", onUnauth);
    return () => window.removeEventListener("arthika:unauthorized", onUnauth);
  }, [refresh]);
  const value = useMemo(() => ({ me, loading, refresh, logout }), [me, loading, refresh, logout]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useSession outside provider");
  return c;
}
