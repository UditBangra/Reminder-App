import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  Platform,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useAuth } from "../../src/auth";
import { formatCredits, useBilling } from "../../src/billing";
import { apiFetch } from "../../src/api";
import { colors, radius, shadow, spacing } from "../../src/theme";
import { Badge, Card, SectionTitle } from "../../src/ui";
import { fmtDate, fmtRelative } from "../../src/utils";
import { registerForPush } from "../../src/push";
import { initRatingTracker, maybeAskForRating } from "../../src/rating";
import { maybePromptForUpdate } from "../../src/appUpdate";
import { getTabBarHeight } from "../../src/safeBottom";

type Reminder = {
  id: string;
  title: string;
  message: string;
  scheduled_at: string;
  next_fire_at?: string | null;
  channels: string[];
  status: string;
  target: { is_self: boolean; name?: string };
  repeat_count: number;
  triggered_count: number;
  pending_channels?: string[];
  needs_user_send?: boolean;
};

const PLANS_INTRO_KEY = "rymind.plans.introSeen";

const CHANNEL_ICON: Record<string, any> = {
  push: "notifications-outline",
  whatsapp: "logo-whatsapp",
  sms: "chatbubble-outline",
  email: "mail-outline",
};

export default function Dashboard() {
  const { user } = useAuth();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  // Tab bar height = 60 + bottom inset (matches (app)/_layout.tsx). Add 16 gap above it for the FAB.
  const tabBarSpace = 60 + Math.max(insets.bottom, Platform.OS === "ios" ? 8 : 6) + 8;
  const fabBottom = tabBarSpace + 16;
  const [items, setItems] = useState<Reminder[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const { billing, refresh: refreshBilling } = useBilling();

  // Show the plans screen once after this update so everyone sees the new plans
  // (and existing users see their welcome gift).
  useEffect(() => {
    if (!billing) return;
    (async () => {
      try {
        if (await AsyncStorage.getItem(PLANS_INTRO_KEY)) return;
        await AsyncStorage.setItem(PLANS_INTRO_KEY, "1");
        router.push({ pathname: "/plans", params: { intro: "1" } });
      } catch {}
    })();
  }, [!!billing]);

  const load = async () => {
    try {
      const data = await apiFetch<Reminder[]>("/reminders");
      setItems(data);
    } catch (e) {
      console.warn(e);
    } finally {
      setLoading(false);
    }
  };

  useFocusEffect(
    useCallback(() => {
      load();
      refreshBilling();
    }, [])
  );

  const isFree = billing?.plan === "free";
  const pausedCount = isFree ? billing?.paid_channel_reminders || 0 : 0;

  useEffect(() => {
    registerForPush();
    initRatingTracker();
    // Soft update check first, then the store-rating ask — staggered so the
    // two prompts never appear at the same moment
    const updateT = setTimeout(() => maybePromptForUpdate(), 1500);
    const ratingT = setTimeout(() => maybeAskForRating(), 6000);
    return () => {
      clearTimeout(updateT);
      clearTimeout(ratingT);
    };
  }, []);

  const greeting = () => {
    const h = new Date().getHours();
    if (h < 12) return "Good morning";
    if (h < 17) return "Good afternoon";
    return "Good evening";
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.greet}>{greeting()},</Text>
          <Text style={styles.name}>{user?.full_name?.split(" ")[0] || "there"}</Text>
        </View>
        {billing ? (
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={() => router.push("/plans")}
            style={[styles.creditPill, isFree ? styles.creditPillFree : null]}
            testID="dashboard-credits"
          >
            <Ionicons name={isFree ? "arrow-up-circle" : "wallet-outline"} size={15} color={isFree ? "#fff" : colors.primary} />
            <Text style={[styles.creditPillText, isFree ? { color: "#fff" } : null]}>
              {isFree ? "Upgrade" : `${formatCredits(billing.credits)} credits`}
            </Text>
          </TouchableOpacity>
        ) : null}
        <View style={styles.avatar}>
          <Text style={{ color: "#fff", fontWeight: "700" }}>
            {(user?.full_name || "U").slice(0, 1).toUpperCase()}
          </Text>
        </View>
      </View>

      {pausedCount > 0 ? (
        <TouchableOpacity activeOpacity={0.9} onPress={() => router.push("/plans")} style={styles.paused} testID="dashboard-paused">
          <View style={styles.pausedIcon}>
            <Ionicons name="pause" size={16} color="#9A6B2F" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.pausedTitle}>WhatsApp, SMS and email are paused</Text>
            <Text style={styles.pausedBody}>
              {pausedCount === 1 ? "1 reminder uses" : `${pausedCount} reminders use`} these channels. Add credits to send them again. App notifications still arrive.
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color="#9A6B2F" />
        </TouchableOpacity>
      ) : null}

      <View style={styles.summaryCard}>
        <View style={{ flex: 1 }}>
          <Text style={styles.summaryLabel}>Active reminders</Text>
          <Text style={styles.summaryValue}>{items.length}</Text>
          <Text style={styles.summarySub}>
            {items[0] ? `Next: ${fmtRelative(items[0].next_fire_at || items[0].scheduled_at)}` : "Nothing scheduled"}
          </Text>
        </View>
        <View style={styles.summaryGlyph}>
          <Ionicons name="sparkles" size={24} color={colors.primary} />
        </View>
      </View>

      <FlatList
        data={items.filter((i) => !i.needs_user_send)}
        keyExtractor={(i) => i.id}
        contentContainerStyle={{ padding: spacing.lg, paddingTop: 0, paddingBottom: tabBarSpace + 80 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
        ListHeaderComponent={
          <>
            {items.some((i) => i.needs_user_send) && (
              <View style={{ marginBottom: spacing.md }}>
                <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 8 }}>
                  <Ionicons name="paper-plane" size={16} color={colors.warning} />
                  <Text style={[styles.sectionLabel, { color: colors.warning, marginLeft: 6 }]}>
                    READY TO SEND
                  </Text>
                </View>
                {items
                  .filter((i) => i.needs_user_send)
                  .map((item) => (
                    <Card
                      key={item.id}
                      testID={`reminder-card-${item.id}`}
                      onPress={() => router.push({ pathname: "/reminder/[id]", params: { id: item.id } })}
                      style={{ marginBottom: 12, borderColor: colors.warning, borderWidth: 1.5, backgroundColor: "#FFFBF2" }}
                    >
                      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                        <Text style={styles.cardTitle} numberOfLines={1}>
                          {item.title}
                        </Text>
                        <Badge label="NEEDS SEND" color={colors.warning} />
                      </View>
                      {item.message ? <Text style={styles.cardMsg} numberOfLines={2}>{item.message}</Text> : null}
                      <View style={styles.cardMeta}>
                        <Ionicons name="person-outline" size={14} color={colors.textMuted} />
                        <Text style={styles.metaText}>For {item.target?.name || "contact"}</Text>
                      </View>
                      <View style={{ flexDirection: "row", marginTop: 10 }}>
                        {item.channels.map((c) => (
                          <View key={c} style={styles.channelDot}>
                            <Ionicons name={CHANNEL_ICON[c]} size={13} color={colors.primary} />
                          </View>
                        ))}
                      </View>
                    </Card>
                  ))}
              </View>
            )}
            <Text style={[styles.sectionLabel, { color: colors.textMuted }]}>UPCOMING</Text>
          </>
        }
        ListEmptyComponent={
          loading ? (
            <View style={styles.empty}>
              <ActivityIndicator color={colors.primary} />
              <Text style={[styles.emptySub, { marginTop: 12 }]}>Loading your reminders…</Text>
            </View>
          ) : items.some((i) => i.needs_user_send) ? null : (
            <View style={styles.empty}>
              <View style={styles.emptyIcon}>
                <Ionicons name="checkmark-done-circle" size={42} color={colors.primary} />
              </View>
              <Text style={styles.emptyTitle}>A clear mind</Text>
              <Text style={styles.emptySub}>You have no active reminders. Tap + to create one.</Text>
            </View>
          )
        }
        renderItem={({ item }) => (
          <Card
            testID={`reminder-card-${item.id}`}
            onPress={() => router.push({ pathname: "/reminder/[id]", params: { id: item.id } })}
            style={{ marginBottom: 12 }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <Text style={styles.cardTitle} numberOfLines={1}>
                {item.title}
              </Text>
              {item.target?.is_self ? null : (
                <Badge label={`For ${item.target?.name || "other"}`} />
              )}
            </View>
            {item.message ? <Text style={styles.cardMsg} numberOfLines={2}>{item.message}</Text> : null}
            <View style={styles.cardMeta}>
              <Ionicons name="calendar-outline" size={14} color={colors.textMuted} />
              <Text style={styles.metaText}>{fmtDate(item.next_fire_at || item.scheduled_at)}</Text>
            </View>
            <View style={{ flexDirection: "row", marginTop: 10, alignItems: "center", justifyContent: "space-between" }}>
              <View style={{ flexDirection: "row" }}>
                {item.channels.map((c) => (
                  <View key={c} style={styles.channelDot}>
                    <Ionicons name={CHANNEL_ICON[c]} size={13} color={colors.primary} />
                  </View>
                ))}
              </View>
              {item.repeat_count > 1 ? (
                <Text style={{ color: colors.textMuted, fontSize: 11 }}>
                  {item.triggered_count}/{item.repeat_count}
                </Text>
              ) : null}
            </View>
          </Card>
        )}
      />

      <TouchableOpacity
        style={[styles.fab, { bottom: fabBottom }]}
        onPress={() => router.push("/reminder/create")}
        activeOpacity={0.9}
        testID="fab-create-reminder"
      >
        <Ionicons name="add" size={28} color="#fff" />
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
  },
  greet: { color: colors.textMuted, fontSize: 14 },
  name: { color: colors.text, fontSize: 26, fontWeight: "800", letterSpacing: -0.5 },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  creditPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 34,
    paddingHorizontal: 12,
    borderRadius: radius.pill,
    backgroundColor: colors.primaryTint,
    marginRight: 10,
  },
  creditPillFree: { backgroundColor: colors.primary },
  creditPillText: { fontSize: 13, fontWeight: "700", color: colors.primary, fontVariant: ["tabular-nums"] },
  paused: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: "#EED9BC",
    // Opaque tint, no elevation: Android draws shadows through translucent cards.
    backgroundColor: "#FBF3E8",
  },
  pausedIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "#F3E2C9",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  pausedTitle: { fontSize: 14, fontWeight: "700", color: colors.text },
  pausedBody: { fontSize: 12, color: colors.textMuted, marginTop: 2, lineHeight: 17 },
  summaryCard: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    padding: spacing.lg,
    backgroundColor: colors.primaryTint,
    borderRadius: radius.lg,
    flexDirection: "row",
    alignItems: "center",
  },
  summaryLabel: { color: colors.primary, fontSize: 12, fontWeight: "700", letterSpacing: 1.2, textTransform: "uppercase" },
  summaryValue: { color: colors.text, fontSize: 40, fontWeight: "800", letterSpacing: -1, marginTop: 4 },
  summarySub: { color: colors.textMuted, marginTop: 4, fontSize: 13 },
  summaryGlyph: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  cardTitle: { fontSize: 17, fontWeight: "700", color: colors.text, flex: 1, marginRight: 8 },
  sectionLabel: {
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1.5,
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },
  cardMsg: { fontSize: 13, color: colors.textMuted, marginTop: 4 },
  cardMeta: { flexDirection: "row", alignItems: "center", marginTop: 10 },
  metaText: { color: colors.textMuted, marginLeft: 6, fontSize: 13 },
  channelDot: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.primaryTint,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 6,
  },
  fab: {
    position: "absolute",
    right: 24,
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
    ...shadow.fab,
  },
  empty: {
    alignItems: "center",
    padding: spacing.xl,
    marginTop: spacing.lg,
  },
  emptyIcon: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: colors.primaryTint,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.md,
  },
  emptyTitle: { fontSize: 22, fontWeight: "800", color: colors.text, marginBottom: 6 },
  emptySub: { color: colors.textMuted, fontSize: 14, textAlign: "center" },
});
