import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import type { PurchasesStoreProduct } from "react-native-purchases";
import { apiFetch } from "./api";
import { useAuth } from "./auth";

/**
 * Plans & credits.
 *
 * The backend is the source of truth for the balance, plan and per-country message
 * rates (GET /billing/me). Purchases go through RevenueCat, which wraps Google Play
 * Billing and the App Store. After a purchase the app asks the backend to sync with
 * RevenueCat so credits land immediately; RevenueCat's webhook is the backstop.
 *
 * RevenueCat is a native module: it only works in a dev/production build, not on web.
 */

// Native module, so never load it on web (the web companion has its own checkout).
const Purchases: typeof import("react-native-purchases").default | null =
  Platform.OS === "web" ? null : require("react-native-purchases").default;

const RC_API_KEY = Platform.select({
  ios: process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY,
  android: process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_KEY,
});

export type PlanId = "free" | "starter" | "popular" | "business";

export type PlanInfo = {
  id: PlanId;
  name: string;
  credits: number;
  tagline: string;
  features: string[];
  recommended: boolean;
  product_id: string | null;
  price: number;
  currency: string;
  display_price: string;
};

export type Rates = {
  country_iso: string | null;
  country_name: string;
  category: "domestic" | "international";
  push: number;
  whatsapp: number;
  sms: number;
  email: number;
};

export type Billing = {
  plan: PlanId;
  last_pack: PlanId | null;
  credits: number;
  active_reminders: number;
  paid_channel_reminders: number;
  free_active_limit: number;
  currency: string;
  plans: PlanInfo[];
  rates: Rates;
  welcome_gift: boolean;
  welcome_gift_credits: number;
};

export type PurchaseResult = "purchased" | "pending" | "cancelled";

type StoreState = "loading" | "ready" | "unavailable";

type Ctx = {
  billing: Billing | null;
  refresh: () => Promise<Billing | null>;
  storeState: StoreState;
  /** Store-localized price (₹ for India, $ elsewhere), falling back to the backend's. */
  priceFor: (plan: PlanInfo) => string;
  purchase: (plan: PlanInfo) => Promise<PurchaseResult>;
};

const BillingCtx = createContext<Ctx | null>(null);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function BillingProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [billing, setBilling] = useState<Billing | null>(null);
  const [products, setProducts] = useState<Record<string, PurchasesStoreProduct>>({});
  const [storeState, setStoreState] = useState<StoreState>("loading");
  const configured = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const b = await apiFetch<Billing>("/billing/me");
      setBilling(b);
      return b;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    if (!user) {
      setBilling(null);
      if (Purchases && configured.current) Purchases.logOut().catch(() => {});
      return;
    }
    refresh();
  }, [user?.id, refresh]);

  // Credits move when reminders fire, so keep the balance roughly current.
  useEffect(() => {
    if (!user) return;
    const t = setInterval(refresh, 60_000);
    return () => clearInterval(t);
  }, [user?.id, refresh]);

  const productIds = (billing?.plans || []).map((p) => p.product_id).filter(Boolean) as string[];
  const productKey = productIds.join(",");

  useEffect(() => {
    if (!user || !productKey) return;
    if (!Purchases || !RC_API_KEY) {
      setStoreState("unavailable");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        if (!configured.current) {
          Purchases.configure({ apiKey: RC_API_KEY, appUserID: user.id });
          configured.current = true;
        } else {
          await Purchases.logIn(user.id);
        }
        const list = await Purchases.getProducts(productKey.split(","), Purchases.PRODUCT_CATEGORY.NON_SUBSCRIPTION);
        if (cancelled) return;
        setProducts(Object.fromEntries(list.map((p) => [p.identifier, p])));
        setStoreState(list.length ? "ready" : "unavailable");
      } catch {
        if (!cancelled) setStoreState("unavailable");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id, productKey]);

  const priceFor = useCallback(
    (plan: PlanInfo) => (plan.product_id && products[plan.product_id]?.priceString) || plan.display_price,
    [products]
  );

  const purchase = useCallback(
    async (plan: PlanInfo): Promise<PurchaseResult> => {
      if (!Purchases) throw new Error("Credit packs can be bought in the Rymind app on your phone.");
      const product = plan.product_id ? products[plan.product_id] : undefined;
      if (!product) throw new Error("This pack isn't available in the store right now. Please try again in a little while.");
      const before = billing?.credits ?? 0;
      try {
        await Purchases.purchaseStoreProduct(product);
      } catch (e: any) {
        if (e?.userCancelled || e?.code === Purchases.PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR) return "cancelled";
        throw new Error(e?.message || "The purchase didn't go through. You haven't been charged.");
      }
      // Ask the backend to credit the purchase now; the webhook covers us if this fails.
      // Either path may land first, so success = the balance went up.
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          await apiFetch("/billing/revenuecat/sync", { method: "POST" });
        } catch {}
        const fresh = await refresh();
        if (fresh && fresh.credits > before) return "purchased";
        await sleep(2000);
      }
      return "pending";
    },
    [products, refresh, billing?.credits]
  );

  return (
    <BillingCtx.Provider value={{ billing, refresh, storeState, priceFor, purchase }}>
      {children}
    </BillingCtx.Provider>
  );
}

export function useBilling() {
  const ctx = useContext(BillingCtx);
  if (!ctx) throw new Error("useBilling must be inside BillingProvider");
  return ctx;
}

export const PAID_CHANNELS = ["whatsapp", "sms", "email"] as const;

export function formatCredits(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

export const PLAN_ORDER: Record<PlanId, number> = { free: 0, starter: 1, popular: 2, business: 3 };
