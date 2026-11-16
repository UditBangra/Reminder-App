import React, { createContext, useContext, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { apiFetch, clearToken, getToken, saveToken } from "./api";
import { refreshPushTokenAfterAuth, unregisterPushToken } from "./push";

export type User = {
  id: string;
  email: string;
  phone: string;
  full_name: string;
  country_code: string;
  expo_push_token?: string | null;
  created_at: string;
  phone_verified: boolean;
  email_verified: boolean;
  marketing_consent?: boolean;
  plan?: "free" | "starter" | "popular" | "business";
  credits?: number;
};

type Ctx = {
  user: User | null;
  loading: boolean;
  signup: (d: {
    email: string;
    phone: string;
    password: string;
    full_name: string;
    country_code: string;
    marketing_consent: boolean;
  }) => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
};

const AuthCtx = createContext<Ctx | null>(null);

// Last known profile, so a launch without internet still opens the app signed in.
const USER_CACHE_KEY = "remindly.user";
const cacheUser = (u: User | null) =>
  (u ? AsyncStorage.setItem(USER_CACHE_KEY, JSON.stringify(u)) : AsyncStorage.removeItem(USER_CACHE_KEY)).catch(() => {});
async function cachedUser(): Promise<User | null> {
  try {
    const raw = await AsyncStorage.getItem(USER_CACHE_KEY);
    return raw ? (JSON.parse(raw) as User) : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    try {
      const token = await getToken();
      if (!token) {
        setUser(null);
        return;
      }
      const me = await apiFetch<User>("/auth/me");
      setUser(me);
      cacheUser(me);
    } catch (e: any) {
      // Only a rejected token means "signed out". A network blip or a server
      // hiccup on launch must not throw the user back to the login screen.
      if (e?.status === 401) {
        await clearToken();
        cacheUser(null);
        setUser(null);
      } else {
        const cached = await cachedUser();
        if (cached) setUser((cur) => cur ?? cached);
      }
    }
  };

  useEffect(() => {
    (async () => {
      await refresh();
      setLoading(false);
    })();
  }, []);

  const login = async (email: string, password: string) => {
    const res = await apiFetch<{ access_token: string; user: User }>("/auth/login", {
      method: "POST",
      auth: false,
      body: JSON.stringify({ email, password }),
    });
    await saveToken(res.access_token);
    setUser(res.user);
    cacheUser(res.user);
    // Re-attempt push registration AFTER auth so token is bound to this user.
    refreshPushTokenAfterAuth().catch(() => {});
  };

  const signup = async (d: {
    email: string;
    phone: string;
    password: string;
    full_name: string;
    country_code: string;
    marketing_consent: boolean;
  }) => {
    const res = await apiFetch<{ access_token: string; user: User }>("/auth/signup", {
      method: "POST",
      auth: false,
      body: JSON.stringify(d),
    });
    await saveToken(res.access_token);
    setUser(res.user);
    cacheUser(res.user);
    refreshPushTokenAfterAuth().catch(() => {});
  };

  const logout = async () => {
    // Detach this device first (needs the token), so the signed-out account's
    // reminders stop arriving here.
    await unregisterPushToken();
    await clearToken();
    cacheUser(null);
    setUser(null);
  };

  return (
    <AuthCtx.Provider value={{ user, loading, login, signup, logout, refresh }}>
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be inside AuthProvider");
  return ctx;
}
