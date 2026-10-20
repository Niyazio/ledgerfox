import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "./api";
import { clearOfflineData, setOfflineUser } from "./offline";

export interface Me {
  user: { id: string; email: string; name: string; username?: string | null; must_change_password?: boolean } | null;
  organisations: { org_id: string; org_name: string; role: string }[];
  companies: { id: string; name: string; org_id: string; base_currency: string; country: string; business_type?: string; is_demo?: number }[];
  brand: string;
  /** "desktop" when running from a data file on a PC/Mac. */
  edition?: "cloud" | "desktop" | "offline";
  registration?: "open" | "closed";
  /** Desktop only, on the computer itself: the default admin / admin sign-in has not been changed yet. */
  default_login?: boolean;
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
      setMe({ user: null, organisations: [], companies: [], brand: "LedgerFox" });
      return null;
    } finally {
      setLoading(false);
    }
  }, []);
  const logout = useCallback(async () => {
    await api.post("/api/auth/logout").catch(() => undefined);
    await clearOfflineData();
    setOfflineUser(null);
    setMe({ user: null, organisations: [], companies: [], brand: me?.brand ?? "LedgerFox" });
  }, [me?.brand]);
  useEffect(() => {
    refresh();
    const onUnauth = () => setMe((m) => (m ? { ...m, user: null } : m));
    window.addEventListener("ledgerfox:unauthorized", onUnauth);
    return () => window.removeEventListener("ledgerfox:unauthorized", onUnauth);
  }, [refresh]);
  useEffect(() => { if (me) setOfflineUser(me.user?.id ?? null); }, [me]);
  const value = useMemo(() => ({ me, loading, refresh, logout }), [me, loading, refresh, logout]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useSession outside provider");
  return c;
}
