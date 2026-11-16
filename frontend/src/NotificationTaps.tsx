import { useEffect, useRef } from "react";
import { Alert, Platform } from "react-native";
import * as Notifications from "expo-notifications";
import { usePathname, useRouter } from "expo-router";
import { useAuth } from "./auth";

type Tap = { id: string; title: string; body: string; data: Record<string, any> };

/**
 * Opens the right screen when the user taps a push notification:
 * - their own reminder -> that reminder's detail page
 * - a reminder someone else set for them -> shows the reminder text (it lives in
 *   the sender's account, so there is no detail page to open)
 * - "credits ran out" -> Plans
 * Taps that arrive before sign-in finishes (cold start) wait until the app has
 * left the splash screen, so the splash redirect can't replace the opened page.
 */
export function NotificationTaps() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const pending = useRef<Tap | null>(null);
  const handled = useRef<Set<string>>(new Set());

  const ready = !loading && !!user && pathname !== "/";

  const open = (tap: Tap) => {
    const { data } = tap;
    if (data?.type === "credits_exhausted") {
      router.push("/plans");
      return;
    }
    if (data?.reminder_id && !data?.from_user_id) {
      router.push({ pathname: "/reminder/[id]", params: { id: String(data.reminder_id) } });
      return;
    }
    if (tap.title || tap.body) {
      Alert.alert(tap.title || "Reminder", tap.body || "");
    }
  };

  const receive = (resp: Notifications.NotificationResponse | null) => {
    if (!resp) return;
    const req = resp.notification.request;
    if (handled.current.has(req.identifier)) return;
    handled.current.add(req.identifier);
    const content = req.content;
    pending.current = {
      id: req.identifier,
      title: content.title || "",
      body: content.body || "",
      data: (content.data as Record<string, any>) || {},
    };
  };

  useEffect(() => {
    if (Platform.OS === "web") return;
    let cancelled = false;
    // App launched by tapping a notification while it was closed.
    Notifications.getLastNotificationResponseAsync()
      .then((resp) => {
        if (cancelled || !resp) return;
        receive(resp);
        flush();
        Notifications.clearLastNotificationResponseAsync?.().catch(() => {});
      })
      .catch(() => {});
    // Taps while the app is running or in the background.
    const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
      receive(resp);
      flush();
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Latest readiness for callbacks registered once above.
  const readyRef = useRef(ready);
  readyRef.current = ready;

  const flush = () => {
    if (!readyRef.current || !pending.current) return;
    const tap = pending.current;
    pending.current = null;
    open(tap);
  };

  useEffect(() => {
    if (ready) flush();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  return null;
}
