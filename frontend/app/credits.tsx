import React, { useCallback, useState } from "react";
import { View, Text, StyleSheet, SectionList, TouchableOpacity, ActivityIndicator, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { format, isToday, isYesterday, parseISO } from "date-fns";
import { apiFetch } from "../src/api";
import { colors, radius, spacing } from "../src/theme";
import { formatCredits, useBilling } from "../src/billing";

type Entry = {
  id: string;
  kind: "purchase" | "gift" | "admin" | "refund" | "usage";
  credits: number;
  balance_after: number | null;
  channel?: "whatsapp" | "sms" | "email" | null;
  role?: "self" | "creator" | null;
  category?: "domestic" | "international" | null;
  country_name?: string | null;
  reminder_title?: string | null;
  target_name?: string | null;
  pack_name?: string | null;
  provider?: string | null;
  note?: string | null;
  created_at: string;
};

const CHANNEL: Record<string, { icon: any; label: string }> = {
  whatsapp: { icon: "logo-whatsapp", label: "WhatsApp" },
  sms: { icon: "chatbubble-outline", label: "SMS" },
  email: { icon: "mail-outline", label: "Email" },
};

function describe(e: Entry): { icon: any; title: string; detail: string } {
  if (e.kind === "usage" && e.channel) {
    const ch = CHANNEL[e.channel];
    const who = e.role === "creator" ? `Your copy of a reminder for ${e.target_name || "someone"}` : "Sent to you";
    const where =
      e.channel === "email" ? "" : e.category === "domestic" ? ", domestic" : `, international (${e.country_name})`;
    return { icon: ch.icon, title: `${ch.label}: ${e.reminder_title || "Reminder"}`, detail: `${who}${where}` };
  }
  if (e.kind === "purchase") {
    return {
      icon: "bag-check-outline",
      title: `${e.pack_name || "Credit"} pack`,
      detail: e.provider === "razorpay" ? "Bought on Rymind Web" : "Bought in the app",
    };
  }
  if (e.kind === "gift") return { icon: "gift-outline", title: e.note || "Gift", detail: "Free credits from Rymind" };
  if (e.kind === "refund") return { icon: "return-down-back-outline", title: e.note || "Refund", detail: "Credits removed" };
  return { icon: "add-circle-outline", title: e.note || "Credits added", detail: "Added by Rymind support" };
}

function dayLabel(iso: string): string {
  const d = parseISO(iso);
  if (isToday(d)) return "Today";
  if (isYesterday(d)) return "Yesterday";
  return format(d, "d MMM yyyy");
}

function group(items: Entry[]) {
  const sections: { title: string; data: Entry[] }[] = [];
  for (const e of items) {
    const title = dayLabel(e.created_at);
    const last = sections[sections.length - 1];
    if (last && last.title === title) last.data.push(e);
    else sections.push({ title, data: [e] });
  }
  return sections;
}

export default function CreditHistory() {
  const router = useRouter();
  const { billing, refresh } = useBilling();
  const [items, setItems] = useState<Entry[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await apiFetch<{ items: Entry[]; next_before: string | null }>("/billing/history?limit=50");
      setItems(res.items);
      setNext(res.next_before);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const loadMore = async () => {
    if (!next || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await apiFetch<{ items: Entry[]; next_before: string | null }>(
        `/billing/history?limit=50&before=${encodeURIComponent(next)}`
      );
      setItems((prev) => [...prev, ...res.items]);
      setNext(res.next_before);
    } catch {
    } finally {
      setLoadingMore(false);
    }
  };

  useFocusEffect(
    useCallback(() => {
      load();
      refresh();
    }, [])
  );

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.topRow}>
        <TouchableOpacity onPress={() => router.back()} testID="credits-back">
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.topTitle}>Credit history</Text>
        <View style={{ width: 26 }} />
      </View>

      <SectionList
        sections={group(items)}
        keyExtractor={(e) => e.id}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await Promise.all([load(), refresh()]);
              setRefreshing(false);
            }}
          />
        }
        onEndReached={loadMore}
        onEndReachedThreshold={0.4}
        ListHeaderComponent={
          billing ? (
            <TouchableOpacity activeOpacity={0.85} onPress={() => router.push("/plans")} style={styles.summary}>
              <View style={{ flex: 1 }}>
                <Text style={styles.summaryValue}>{formatCredits(billing.credits)} credits</Text>
                <Text style={styles.summarySub}>
                  {billing.plan === "free" ? "Free plan" : `${billing.plans.find((p) => p.id === billing.plan)?.name} plan`}
                </Text>
              </View>
              <Text style={styles.summaryLink}>Buy credits</Text>
            </TouchableOpacity>
          ) : null
        }
        renderSectionHeader={({ section }) => <Text style={styles.day}>{section.title}</Text>}
        renderItem={({ item, index, section }) => {
          const d = describe(item);
          const positive = item.credits > 0;
          return (
            <View
              style={[
                styles.row,
                index === 0 ? styles.rowFirst : null,
                index === section.data.length - 1 ? styles.rowLast : styles.rowDivider,
              ]}
            >
              <View style={[styles.icon, positive ? { backgroundColor: "#E4F0E9" } : null]}>
                <Ionicons name={d.icon} size={17} color={colors.primary} />
              </View>
              <View style={{ flex: 1, marginRight: 10 }}>
                <Text style={styles.title} numberOfLines={1}>{d.title}</Text>
                <Text style={styles.detail} numberOfLines={2}>{d.detail}</Text>
                <Text style={styles.time}>{format(parseISO(item.created_at), "h:mm a")}</Text>
              </View>
              <View style={{ alignItems: "flex-end" }}>
                <Text style={[styles.delta, { color: positive ? colors.success : colors.text }]}>
                  {positive ? "+" : "−"}
                  {formatCredits(Math.abs(item.credits))}
                </Text>
                {item.balance_after !== null ? (
                  <Text style={styles.after}>{formatCredits(item.balance_after)} left</Text>
                ) : null}
              </View>
            </View>
          );
        }}
        ListEmptyComponent={
          loading ? (
            <View style={styles.empty}>
              <ActivityIndicator color={colors.primary} />
            </View>
          ) : (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>{error ? "Couldn't load your history" : "No credit activity yet"}</Text>
              <Text style={styles.emptySub}>
                {error || "Purchases and every WhatsApp, SMS or email we send for you will show up here."}
              </Text>
            </View>
          )
        }
        ListFooterComponent={loadingMore ? <ActivityIndicator color={colors.primary} style={{ marginTop: 16 }} /> : null}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  topRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
  },
  topTitle: { fontSize: 18, fontWeight: "700", color: colors.text },
  summary: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.primaryTint,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  summaryValue: { fontSize: 20, fontWeight: "800", color: colors.text, fontVariant: ["tabular-nums"] },
  summarySub: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
  summaryLink: { fontSize: 14, fontWeight: "700", color: colors.primary },
  day: { fontSize: 13, fontWeight: "700", color: colors.textMuted, marginTop: spacing.lg, marginBottom: spacing.sm },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: colors.border,
  },
  rowFirst: { borderTopWidth: 1, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg },
  rowLast: { borderBottomWidth: 1, borderBottomLeftRadius: radius.lg, borderBottomRightRadius: radius.lg },
  rowDivider: { borderBottomWidth: 1, borderBottomColor: colors.border },
  icon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: colors.primaryTint,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  title: { fontSize: 15, fontWeight: "600", color: colors.text },
  detail: { fontSize: 12, color: colors.textMuted, marginTop: 2, lineHeight: 16 },
  time: { fontSize: 11, color: colors.placeholder, marginTop: 4 },
  delta: { fontSize: 15, fontWeight: "800", fontVariant: ["tabular-nums"] },
  after: { fontSize: 11, color: colors.textMuted, marginTop: 3, fontVariant: ["tabular-nums"] },
  empty: { alignItems: "center", paddingVertical: spacing.xxl, paddingHorizontal: spacing.lg },
  emptyTitle: { fontSize: 17, fontWeight: "700", color: colors.text, marginBottom: 6 },
  emptySub: { fontSize: 13, color: colors.textMuted, textAlign: "center", lineHeight: 19 },
});
