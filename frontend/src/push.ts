import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import Constants from "expo-constants";
import { Platform } from "react-native";
import { apiFetch } from "./api";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }) as any,
});

// Module-level guard: prevents parallel duplicate registrations
let inFlight: Promise<string | null> | null = null;
let cachedToken: string | null = null;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Try to fetch an Expo Push Token with retry & exponential backoff.
 * Handles common Android FCM `SERVICE_NOT_AVAILABLE` first-launch race condition.
 */
async function fetchTokenWithRetry(projectId?: string): Promise<string> {
  const delays = [0, 2000, 4000, 8000]; // immediate, 2s, 4s, 8s
  let lastErr: any = null;
  for (let i = 0; i < delays.length; i++) {
    if (delays[i] > 0) await sleep(delays[i]);
    try {
      const tokenRes = await Notifications.getExpoPushTokenAsync(
        projectId ? { projectId } : undefined
      );
      if (tokenRes?.data) return tokenRes.data;
    } catch (e: any) {
      lastErr = e;
      const msg = String(e?.message || e);
      // Only retry on transient errors
      const transient =
        msg.includes("SERVICE_NOT_AVAILABLE") ||
        msg.includes("TIMEOUT") ||
        msg.includes("Network") ||
        msg.includes("network") ||
        msg.includes("UNAVAILABLE");
      if (!transient) throw e;
      console.log(`[push] token fetch attempt ${i + 1} transient err, retrying…`);
    }
  }
  throw lastErr ?? new Error("Failed to fetch push token after retries");
}

export async function registerForPush(): Promise<string | null> {
  if (Platform.OS === "web") return null;
  if (!Device.isDevice) return null;

  // If a registration is already running, return that same promise
  if (inFlight) return inFlight;
  // If we've already cached a successful token this session, return it
  if (cachedToken) return cachedToken;

  inFlight = (async () => {
    try {
      const { status: existing } = await Notifications.getPermissionsAsync();
      let finalStatus = existing;
      if (existing !== "granted") {
        const { status } = await Notifications.requestPermissionsAsync();
        finalStatus = status;
      }
      if (finalStatus !== "granted") {
        console.log("[push] permission not granted");
        return null;
      }

      const projectId =
        (Constants?.expoConfig as any)?.extra?.eas?.projectId ??
        (Constants as any)?.easConfig?.projectId;

      const token = await fetchTokenWithRetry(projectId);
      cachedToken = token;

      try {
        await apiFetch("/auth/push-token", {
          method: "POST",
          body: JSON.stringify({ token }),
        });
      } catch {
        // user may not be authed yet — token will be re-sent after login
      }
      console.log("[push] registered ok");
      return token;
    } catch (e: any) {
      console.log("[push] register failed (will retry next launch):", e?.message || e);
      return null;
    } finally {
      // allow another attempt next time only if we failed (cachedToken stays null)
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Detach this device's push token from the signed-in account (call before logout). */
export async function unregisterPushToken(): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    // Don't hold up sign-out for long if the network is slow.
    await Promise.race([
      apiFetch("/auth/push-token", { method: "DELETE" }),
      new Promise((resolve) => setTimeout(resolve, 4000)),
    ]);
  } catch {
    // Offline or old backend: the server also moves the token on the next sign-in.
  }
  cachedToken = null;
}

/** Re-register after sign-in so the token is attached to the right account. */
export async function refreshPushTokenAfterAuth(): Promise<void> {
  // Reset cache so we send the token to the API for the now-authed user
  cachedToken = null;
  await registerForPush();
}
