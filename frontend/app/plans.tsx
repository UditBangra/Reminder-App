import React, { useCallback, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, radius, spacing } from "../src/theme";
import { Card, SectionTitle } from "../src/ui";
import { Shine } from "../src/Shine";
import { formatCredits, PLAN_ORDER, PlanInfo, useBilling } from "../src/billing";

// Popular is the recommended pack: dark sage with a light sweep. Everything else stays quiet.
const MINT = "#CFE3D8";

export default function Plans() {
  const router = useRouter();
  const { intro } = useLocalSearchParams<{ intro?: string }>();
  const { billing, refresh, storeState, priceFor, purchase } = useBilling();
  const [busy, setBusy] = useState<string | null>(null);

  useFocusEffect(useCallback(() => { refresh(); }, [refresh]));

  const buy = async (plan: PlanInfo) => {
    if (storeState !== "ready") {
      return Alert.alert(
        "Store unavailable",
        "Credit packs couldn't be loaded from the store. Check your connection and try again."
      );
    }
    setBusy(plan.id);
    try {
      const result = await purchase(plan);
      if (result === "purchased") {
        Alert.alert("Credits added", `${formatCredits(plan.credits)} credits are now in your account.`);
      } else if (result === "pending") {
        Alert.alert("Purchase received", "Your credits will appear in a minute or two.");
      }
    } catch (e: any) {
      Alert.alert("Purchase failed", e.message);
    } finally {
      setBusy(null);
    }
  };

  if (!billing) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <Header onBack={() => router.back()} />
        <View style={styles.loading}>
          <ActivityIndicator color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  const current = billing.plan;
  const currentPlan = billing.plans.find((p) => p.id === current);
  const starter = billing.plans.find((p) => p.id === "starter");
  const r = billing.rates;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Header onBack={() => router.back()} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl }}>
        {intro ? (
          <View style={styles.intro}>
            <Ionicons name={billing.welcome_gift ? "gift-outline" : "sparkles-outline"} size={20} color={colors.primary} />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={styles.introTitle}>
                {billing.welcome_gift ? "A gift to get you started" : "Rymind now has plans"}
              </Text>
              <Text style={styles.introBody}>
                {billing.welcome_gift
                  ? `We've added ${formatCredits(billing.welcome_gift_credits)} free credits to your account. They cover WhatsApp, SMS and email reminders.`
                  : "App notifications stay free. Credit packs unlock WhatsApp, SMS and email reminders."}
              </Text>
            </View>
          </View>
        ) : null}

        <View style={styles.balance}>
          <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between" }}>
            <View>
              <Text style={styles.balanceValue}>{formatCredits(billing.credits)}</Text>
              <Text style={styles.balanceLabel}>credits left</Text>
            </View>
            <View style={styles.planPill}>
              <Text style={styles.planPillText}>{currentPlan?.name || "Free"} plan</Text>
            </View>
          </View>
          <View style={styles.balanceFoot}>
            <Text style={styles.balanceNote}>
              {current === "free"
                ? `App notifications only, up to ${billing.free_active_limit} active reminders.`
                : "Credits never expire."}
            </Text>
            <TouchableOpacity onPress={() => router.push("/credits")} hitSlop={8} testID="plans-history">
              <Text style={styles.link}>History</Text>
            </TouchableOpacity>
          </View>
        </View>

        <SectionTitle style={{ marginTop: spacing.lg }}>Credit packs</SectionTitle>
        <Text style={styles.sectionNote}>One-time purchase. No subscription and nothing renews.</Text>

        <View style={{ gap: 12 }}>
          {billing.plans.map((plan) =>
            plan.id === "free" ? (
              <FreeCard key={plan.id} plan={plan} isCurrent={current === "free"} />
            ) : (
              <PackCard
                key={plan.id}
                plan={plan}
                price={priceFor(plan)}
                isCurrent={current === plan.id}
                cta={ctaFor(plan, current)}
                busy={busy === plan.id}
                disabled={!!busy && busy !== plan.id}
                onBuy={() => buy(plan)}
              />
            )
          )}
        </View>

        <SectionTitle style={{ marginTop: spacing.xl }}>What a credit buys</SectionTitle>
        <Card>
          <Text style={styles.ratesIntro}>
            {r.category === "domestic"
              ? "Prices per message to your Indian number and your email."
              : `Prices per message to your ${r.country_name} number and your email. Message costs differ by country.`}
          </Text>
          <RateRow icon="notifications-outline" label="App notification" value="Free" />
          <RateRow icon="logo-whatsapp" label="WhatsApp" value={`${formatCredits(r.whatsapp)} credits`} />
          <RateRow icon="chatbubble-outline" label="SMS" value={`${formatCredits(r.sms)} credits`} />
          <RateRow icon="mail-outline" label="Email" value={`${formatCredits(r.email)} credits`} last />
          {starter ? (
            <Text style={styles.ratesExample}>
              {`Starter's ${formatCredits(starter.credits)} credits cover about ${formatCredits(Math.floor(starter.credits / r.whatsapp))} WhatsApp messages, ${formatCredits(Math.floor(starter.credits / r.sms))} SMS or ${formatCredits(Math.floor(starter.credits / r.email))} emails.`}
            </Text>
          ) : null}
        </Card>
        <Text style={styles.footnote}>
          A reminder for someone else sends you a copy on the channels you pick, and that copy uses credits. Sending it on to them from your own phone is free.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function ctaFor(plan: PlanInfo, current: PlanInfo["id"]): string {
  if (current === "free") return `Upgrade to ${plan.name}`;
  if (plan.id === current) return "Buy again";
  return PLAN_ORDER[plan.id] > PLAN_ORDER[current] ? `Upgrade to ${plan.name}` : `Buy ${plan.name}`;
}

function Header({ onBack }: { onBack: () => void }) {
  return (
    <View style={styles.topRow}>
      <TouchableOpacity onPress={onBack} testID="plans-back">
        <Ionicons name="chevron-back" size={26} color={colors.text} />
      </TouchableOpacity>
      <Text style={styles.topTitle}>Plans and credits</Text>
      <View style={{ width: 26 }} />
    </View>
  );
}

function PackCard({
  plan,
  price,
  isCurrent,
  cta,
  busy,
  disabled,
  onBuy,
}: {
  plan: PlanInfo;
  price: string;
  isCurrent: boolean;
  cta: string;
  busy: boolean;
  disabled: boolean;
  onBuy: () => void;
}) {
  const hero = plan.recommended;
  const fg = hero ? "#FFFFFF" : colors.text;
  const muted = hero ? "rgba(255,255,255,0.72)" : colors.textMuted;
  return (
    <View style={[styles.pack, hero ? styles.packHero : null, isCurrent && !hero ? styles.packCurrent : null]}>
      <View style={styles.packHead}>
        <Text style={[styles.packName, { color: fg }]}>{plan.name}</Text>
        {isCurrent ? (
          <View style={[styles.tag, { backgroundColor: hero ? MINT : colors.primaryTint }]}>
            <Text style={[styles.tagText, { color: colors.primary }]}>Current plan</Text>
          </View>
        ) : hero ? (
          <View style={[styles.tag, { backgroundColor: MINT }]}>
            <Ionicons name="star" size={11} color={colors.primary} style={{ marginRight: 4 }} />
            <Text style={[styles.tagText, { color: colors.primary }]}>Recommended</Text>
          </View>
        ) : null}
      </View>
      <Text style={[styles.tagline, { color: muted }]}>{plan.tagline}</Text>

      <View style={styles.priceRow}>
        <Text style={[styles.price, { color: fg }]}>{price}</Text>
        <Text style={[styles.priceCredits, { color: muted }]}>for {formatCredits(plan.credits)} credits</Text>
      </View>

      {plan.features.slice(1).map((f) => (
        <View key={f} style={styles.feature}>
          <Ionicons name="checkmark" size={16} color={hero ? MINT : colors.primary} />
          <Text style={[styles.featureText, { color: fg }]}>{f}</Text>
        </View>
      ))}

      <TouchableOpacity
        activeOpacity={0.85}
        onPress={onBuy}
        disabled={busy || disabled}
        style={[
          styles.cta,
          hero ? { backgroundColor: "#FFFFFF" } : isCurrent ? { backgroundColor: colors.primaryTint } : { backgroundColor: colors.primary },
          disabled ? { opacity: 0.5 } : null,
        ]}
        testID={`buy-${plan.id}`}
      >
        {busy ? (
          <ActivityIndicator color={hero || isCurrent ? colors.primary : "#fff"} />
        ) : (
          <Text style={[styles.ctaText, { color: hero || isCurrent ? colors.primary : "#fff" }]}>{cta}</Text>
        )}
      </TouchableOpacity>
      {hero ? <Shine /> : null}
    </View>
  );
}

function FreeCard({ plan, isCurrent }: { plan: PlanInfo; isCurrent: boolean }) {
  return (
    <View style={[styles.pack, styles.packFree, isCurrent ? styles.packCurrent : null]}>
      <View style={styles.packHead}>
        <Text style={styles.packName}>{plan.name}</Text>
        {isCurrent ? (
          <View style={[styles.tag, { backgroundColor: colors.primaryTint }]}>
            <Text style={[styles.tagText, { color: colors.primary }]}>Current plan</Text>
          </View>
        ) : null}
      </View>
      <Text style={styles.tagline}>{plan.tagline}</Text>
      {plan.features.map((f) => (
        <View key={f} style={styles.feature}>
          <Ionicons name="checkmark" size={16} color={colors.textMuted} />
          <Text style={[styles.featureText, { color: colors.textMuted }]}>{f}</Text>
        </View>
      ))}
      {!isCurrent ? (
        <Text style={styles.freeNote}>You move back to Free automatically when your credits run out.</Text>
      ) : null}
    </View>
  );
}

function RateRow({ icon, label, value, last }: { icon: any; label: string; value: string; last?: boolean }) {
  return (
    <View style={[styles.rateRow, last ? null : { borderBottomWidth: 1, borderBottomColor: colors.border }]}>
      <View style={styles.rateIcon}>
        <Ionicons name={icon} size={16} color={colors.primary} />
      </View>
      <Text style={styles.rateLabel}>{label}</Text>
      <Text style={styles.rateValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  topRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
  },
  topTitle: { fontSize: 18, fontWeight: "700", color: colors.text },
  intro: {
    flexDirection: "row",
    alignItems: "flex-start",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  introTitle: { fontSize: 15, fontWeight: "700", color: colors.text },
  introBody: { fontSize: 13, color: colors.textMuted, marginTop: 4, lineHeight: 19 },
  balance: {
    backgroundColor: colors.primaryTint,
    borderRadius: radius.xl,
    padding: spacing.lg,
  },
  balanceValue: {
    fontSize: 40,
    fontWeight: "800",
    color: colors.text,
    letterSpacing: -1,
    fontVariant: ["tabular-nums"],
  },
  balanceLabel: { fontSize: 14, color: colors.textMuted, marginTop: 2 },
  planPill: {
    backgroundColor: colors.surface,
    borderRadius: radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginTop: 6,
  },
  planPillText: { fontSize: 12, fontWeight: "700", color: colors.primary },
  balanceFoot: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: "#DDE7E1",
  },
  balanceNote: { flex: 1, fontSize: 13, color: colors.textMuted, marginRight: 12 },
  link: { fontSize: 14, fontWeight: "700", color: colors.primary },
  sectionNote: { fontSize: 13, color: colors.textMuted, marginTop: -4, marginBottom: spacing.md },
  pack: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    overflow: "hidden",
  },
  packHero: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
    paddingVertical: spacing.lg + 4,
  },
  packCurrent: { borderColor: colors.primary, borderWidth: 1.5 },
  packFree: { backgroundColor: colors.surfaceAlt, borderColor: colors.surfaceAlt, paddingVertical: spacing.md + 4 },
  packHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  packName: { fontSize: 20, fontWeight: "800", color: colors.text, letterSpacing: -0.3 },
  tag: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  tagText: { fontSize: 11, fontWeight: "700" },
  tagline: { fontSize: 13, color: colors.textMuted, marginTop: 4, lineHeight: 18 },
  priceRow: { flexDirection: "row", alignItems: "baseline", marginTop: spacing.md, marginBottom: spacing.sm },
  price: { fontSize: 30, fontWeight: "800", letterSpacing: -0.8, fontVariant: ["tabular-nums"] },
  priceCredits: { fontSize: 14, marginLeft: 8 },
  feature: { flexDirection: "row", alignItems: "center", marginTop: 6 },
  featureText: { fontSize: 14, marginLeft: 8 },
  freeNote: { fontSize: 12, color: colors.textMuted, marginTop: spacing.sm, lineHeight: 17 },
  cta: {
    height: 50,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    marginTop: spacing.md,
  },
  ctaText: { fontSize: 15, fontWeight: "700" },
  ratesIntro: { fontSize: 13, color: colors.textMuted, lineHeight: 19, marginBottom: 4 },
  rateRow: { flexDirection: "row", alignItems: "center", paddingVertical: 12 },
  rateIcon: {
    width: 30,
    height: 30,
    borderRadius: 9,
    backgroundColor: colors.primaryTint,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  rateLabel: { flex: 1, fontSize: 15, fontWeight: "600", color: colors.text },
  rateValue: { fontSize: 14, fontWeight: "700", color: colors.text, fontVariant: ["tabular-nums"] },
  ratesExample: {
    fontSize: 13,
    color: colors.textMuted,
    lineHeight: 19,
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  footnote: { fontSize: 12, color: colors.textMuted, lineHeight: 18, marginTop: spacing.md, paddingHorizontal: 4 },
});
