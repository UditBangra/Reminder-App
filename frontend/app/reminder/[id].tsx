import React, { useCallback, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  Linking,
  Platform,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Button, Card, SectionTitle, Badge } from "../../src/ui";
import { colors, radius, spacing } from "../../src/theme";
import { apiFetch } from "../../src/api";
import { fmtDate, fmtRelative } from "../../src/utils";

type Reminder = {
  id: string;
  title: string;
  message: string;
  scheduled_at: string;
  next_fire_at?: string | null;
  status: string;
  channels: string[];
  repeat_count: number;
  triggered_count: number;
  repeat_interval_hours: number;
  lead_minutes: number;
  target: { is_self: boolean; name?: string; phone?: string; email?: string };
  pending_channels?: string[];
  needs_user_send?: boolean;
};

function fmtInterval(h: number): string {
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (h > 0 && h % 8760 === 0) return plural(h / 8760, "year");
  if (h > 0 && h % 720 === 0) return plural(h / 720, "month");
  if (h > 0 && h % 168 === 0) return plural(h / 168, "week");
  if (h > 0 && h % 24 === 0) return plural(h / 24, "day");
  if (h >= 1) return plural(h, "hour");
  return `${Math.round(h * 60)} min`;
}

const CHANNEL_META: Record<string, { icon: any; label: string }> = {
  push: { icon: "notifications-outline", label: "App Notification" },
  whatsapp: { icon: "logo-whatsapp", label: "WhatsApp" },
  sms: { icon: "chatbubble-outline", label: "SMS" },
  email: { icon: "mail-outline", label: "Email" },
};

export default function ReminderDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [r, setR] = useState<Reminder | null>(null);

  const load = async () => {
    try {
      const d = await apiFetch<Reminder>(`/reminders/${id}`);
      setR(d);
    } catch (e: any) {
      if (e?.status === 404) {
        // Deleted, or opened from an old notification: don't sit on "Loading…".
        Alert.alert("Reminder not found", "This reminder was deleted or is no longer available.");
        if (router.canGoBack()) router.back();
        else router.replace("/(app)/dashboard");
        return;
      }
      Alert.alert("Error", e.message);
    }
  };
  useFocusEffect(useCallback(() => { load(); }, [id]));

  const confirm = (title: string, body: string, onOk: () => void, okLabel = "Confirm", destructive = false) => {
    Alert.alert(title, body, [
      { text: "Cancel", style: "cancel" },
      { text: okLabel, style: destructive ? "destructive" : "default", onPress: onOk },
    ]);
  };

  const doAction = async (a: "complete" | "cancel" | "postpone", postpone_minutes = 30) => {
    try {
      await apiFetch(`/reminders/${id}/action`, {
        method: "POST",
        body: JSON.stringify({ action: a, postpone_minutes }),
      });
      if (a === "complete" || a === "cancel") {
        router.back();
      } else {
        await load();
      }
    } catch (e: any) {
      Alert.alert("Error", e.message);
    }
  };

  const action = (a: "complete" | "cancel" | "postpone", postpone_minutes = 30) => {
    if (a === "complete") {
      confirm("Mark as completed?", "This reminder will move to history.", () => doAction(a));
    } else if (a === "cancel") {
      confirm("Cancel this reminder?", "It will stop firing and move to history.", () => doAction(a), "Yes, cancel", true);
    } else {
      confirm(
        "Postpone 30 minutes?",
        "We'll ring you again after 30 minutes.",
        () => doAction(a, postpone_minutes)
      );
    }
  };

  const delReminder = () => {
    confirm(
      "Delete reminder?",
      "This permanently removes the reminder.",
      async () => {
        try {
          await apiFetch(`/reminders/${id}`, { method: "DELETE" });
          router.back();
        } catch (e: any) {
          Alert.alert("Error", e.message);
        }
      },
      "Delete",
      true
    );
  };

  const openChannel = async (channel: string) => {
    if (!r) return;
    const phone = r.target?.phone?.replace(/[^0-9+]/g, "") || "";
    const msg = encodeURIComponent(`${r.title}\n${r.message || ""}`);
    let url = "";
    if (channel === "whatsapp" && phone) {
      url = `https://wa.me/${phone.replace(/^\+/, "")}?text=${msg}`;
    } else if (channel === "sms" && phone) {
      url = Platform.OS === "ios" ? `sms:${phone}&body=${msg}` : `sms:${phone}?body=${msg}`;
    } else if (channel === "email" && r.target?.email) {
      url = `mailto:${r.target.email}?subject=${encodeURIComponent(r.title)}&body=${msg}`;
    }
    if (!url) return Alert.alert("Unavailable", "Contact info missing for this channel.");
    try {
      await Linking.openURL(url);
      // If this channel is pending (reminder has fired for other person), mark it sent
      if (r.pending_channels?.includes(channel)) {
        try {
          await apiFetch(`/reminders/${id}/mark-sent`, {
            method: "POST",
            body: JSON.stringify({ channel }),
          });
          await load();
        } catch {}
      }
    } catch {
      Alert.alert("Can't open", "This device cannot open the selected app.");
    }
  };

  if (!r) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.background, alignItems: "center", justifyContent: "center" }}>
        <Text style={{ color: colors.textMuted }}>Loading…</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={["top"]}>
      <View style={styles.topRow}>
        <TouchableOpacity onPress={() => router.back()} testID="detail-back">
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.topTitle}>Reminder</Text>
        <TouchableOpacity onPress={delReminder} testID="detail-delete">
          <Ionicons name="trash-outline" size={22} color={colors.danger} />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 80 + Math.max(insets.bottom, 0) }}>
        <View style={styles.hero}>
          <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 8 }}>
            <Badge
              label={r.status.toUpperCase()}
              color={
                r.status === "completed" ? colors.success : r.status === "cancelled" ? colors.danger : colors.primary
              }
            />
            {!r.target?.is_self && (
              <View style={{ marginLeft: 8 }}>
                <Badge label={`For ${r.target?.name || "contact"}`} color={colors.info} />
              </View>
            )}
          </View>
          <Text style={styles.title}>{r.title}</Text>
          {r.message ? <Text style={styles.msg}>{r.message}</Text> : null}
        </View>

        <Card style={{ marginTop: spacing.md }}>
          <Row icon="calendar-outline" label="Scheduled" value={fmtDate(r.scheduled_at)} />
          {r.next_fire_at && (
            <>
              <Divider />
              <Row icon="flash-outline" label="Next fire" value={`${fmtDate(r.next_fire_at)} · ${fmtRelative(r.next_fire_at)}`} />
            </>
          )}
          <Divider />
          <Row
            icon="repeat-outline"
            label="Repeats"
            value={
              r.repeat_count === 1
                ? "One-time"
                : `${r.triggered_count}/${r.repeat_count === -1 ? "∞" : r.repeat_count} times · every ${fmtInterval(r.repeat_interval_hours)}`
            }
          />
          {r.lead_minutes > 0 && (
            <>
              <Divider />
              <Row icon="alarm-outline" label="Lead" value={`${r.lead_minutes} min before`} />
            </>
          )}
        </Card>

        <View style={{ marginTop: spacing.lg }}>
          <SectionTitle>Delivery channels</SectionTitle>
          {r.pending_channels && r.pending_channels.length > 0 && (
            <Card
              style={{
                backgroundColor: "#FFF4E5",
                borderColor: colors.warning,
                flexDirection: "row",
                alignItems: "center",
                marginBottom: 10,
              }}
              testID="needs-send-banner"
            >
              <Ionicons name="alert-circle" size={22} color={colors.warning} style={{ marginRight: 10 }} />
              <Text style={{ flex: 1, color: colors.text, fontSize: 13 }}>
                It's time! Tap <Text style={{ fontWeight: "700" }}>Send</Text> on each channel below. Reminder moves to history once all are sent.
              </Text>
            </Card>
          )}
          <View style={{ gap: 10 }}>
            {r.channels.map((c) => {
              const isPending = r.pending_channels?.includes(c);
              return (
                <View
                  key={c}
                  style={[
                    styles.channelRow,
                    isPending && { borderColor: colors.warning, backgroundColor: "#FFFBF2" },
                  ]}
                >
                  <View style={styles.chIcon}>
                    <Ionicons name={CHANNEL_META[c]?.icon || "send"} size={18} color={colors.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: colors.text, fontWeight: "600" }}>{CHANNEL_META[c]?.label || c}</Text>
                    {isPending && (
                      <Text style={{ color: colors.warning, fontSize: 11, fontWeight: "700", marginTop: 2 }}>
                        TAP SEND TO DELIVER
                      </Text>
                    )}
                  </View>
                  {!r.target?.is_self && c !== "push" && (
                    <TouchableOpacity
                      onPress={() => openChannel(c)}
                      style={[styles.sendBtn, isPending && { backgroundColor: colors.warning }]}
                      testID={`send-${c}`}
                    >
                      <Text style={{ color: "#fff", fontWeight: "700", fontSize: 12 }}>Send</Text>
                    </TouchableOpacity>
                  )}
                </View>
              );
            })}
          </View>
        </View>

        {r.status === "pending" && (
          <View style={{ marginTop: spacing.lg, gap: 10 }}>
            <Button label="Mark as completed" icon="checkmark-done" onPress={() => action("complete")} testID="action-complete" />
            <Button label="Postpone 30 min" variant="secondary" icon="time" onPress={() => action("postpone", 30)} testID="action-postpone" />
            <Button label={r.repeat_count === -1 ? "Stop Reminder" : "Cancel reminder"} variant="danger" icon={r.repeat_count === -1 ? "stop-circle" : "close-circle"} onPress={() => action("cancel")} testID="action-cancel" />
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({ icon, label, value }: { icon: any; label: string; value: string }) {
  return (
    <View style={rowStyles.row}>
      <View style={rowStyles.iconWrap}>
        <Ionicons name={icon} size={18} color={colors.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ color: colors.textMuted, fontSize: 12 }}>{label}</Text>
        <Text style={{ color: colors.text, fontWeight: "600" }}>{value}</Text>
      </View>
    </View>
  );
}
function Divider() { return <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 6 }} />; }

const rowStyles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 8 },
  iconWrap: {
    width: 34, height: 34, borderRadius: 10, backgroundColor: colors.primaryTint,
    alignItems: "center", justifyContent: "center", marginRight: 12,
  },
});

const styles = StyleSheet.create({
  topRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  topTitle: { fontSize: 18, fontWeight: "700", color: colors.text },
  hero: {
    backgroundColor: colors.primaryTint,
    borderRadius: radius.xl,
    padding: spacing.lg,
    marginTop: spacing.md,
  },
  title: { fontSize: 26, fontWeight: "800", color: colors.text, letterSpacing: -0.5 },
  msg: { color: colors.text, marginTop: 6, fontSize: 15, opacity: 0.85 },
  channelRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 12,
    borderRadius: radius.md,
  },
  chIcon: {
    width: 36, height: 36, borderRadius: 10, backgroundColor: colors.primaryTint,
    alignItems: "center", justifyContent: "center", marginRight: 10,
  },
  sendBtn: {
    backgroundColor: colors.primary,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radius.pill,
  },
});
