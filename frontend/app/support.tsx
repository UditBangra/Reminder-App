import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  Linking,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Application from "expo-application";
import Constants from "expo-constants";
import { apiFetch } from "../src/api";
import { useAuth } from "../src/auth";
import { Button, Card, Chip, Input, SectionTitle } from "../src/ui";
import { colors, radius, spacing } from "../src/theme";
import { isValidEmail } from "../src/utils";

// Help & Support. Reachable signed out (from the sign-in screen, for people who
// can't log in) and signed in (Profile). The message is emailed to the Rymind team,
// who reply to the email address entered here.
type Topic = "login" | "billing" | "reminders" | "other";
const TOPICS: { id: Topic; label: string; icon: any }[] = [
  { id: "login", label: "Can't sign in", icon: "lock-closed-outline" },
  { id: "reminders", label: "Reminders", icon: "alarm-outline" },
  { id: "billing", label: "Plans and credits", icon: "wallet-outline" },
  { id: "other", label: "Something else", icon: "help-circle-outline" },
];

export default function Support() {
  const router = useRouter();
  const { user } = useAuth();
  const [topic, setTopic] = useState<Topic>(user ? "reminders" : "login");
  const [name, setName] = useState(user?.full_name || "");
  const [email, setEmail] = useState(user?.email || "");
  const [phone, setPhone] = useState(user?.phone ? `${user.country_code || ""}${user.phone}` : "");
  const [message, setMessage] = useState("");
  const [err, setErr] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [supportEmail, setSupportEmail] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ email: string | null }>("/support/info", { auth: false })
      .then((r) => setSupportEmail(r?.email || null))
      .catch(() => {});
  }, []);

  const back = () => (router.canGoBack() ? router.back() : router.replace("/"));

  const submit = async () => {
    setErr("");
    if (!name.trim()) return setErr("Please enter your name.");
    if (!isValidEmail(email)) return setErr("Please enter a valid email address so we can reply.");
    if (message.trim().length < 5) return setErr("Please tell us a little more about the problem.");
    setSending(true);
    try {
      await apiFetch("/support/contact", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim().toLowerCase(),
          phone: phone.trim() || null,
          topic,
          message: message.trim(),
          source: "app",
          platform: Platform.OS,
          app_version: Application.nativeApplicationVersion || Constants.expoConfig?.version || null,
        }),
      });
      setSent(true);
    } catch (e: any) {
      setErr(e.message || "Couldn't send your message. Please try again.");
    } finally {
      setSending(false);
    }
  };

  const emailUs = () => {
    if (!supportEmail) return;
    Linking.openURL(`mailto:${supportEmail}?subject=${encodeURIComponent("Rymind help")}`).catch(() => {});
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <View style={styles.topRow}>
        <TouchableOpacity onPress={back} testID="support-back" hitSlop={8}>
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.topTitle}>Help and support</Text>
        <View style={{ width: 26 }} />
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          {sent ? (
            <View style={styles.done}>
              <View style={styles.doneIcon}>
                <Ionicons name="checkmark" size={30} color={colors.primary} />
              </View>
              <Text style={styles.doneTitle}>Message sent</Text>
              <Text style={styles.doneBody}>
                {`Thanks for reaching out. We'll reply to ${email.trim().toLowerCase()} as soon as we can.`}
              </Text>
              <Button label="Done" onPress={back} style={{ marginTop: spacing.lg, alignSelf: "stretch" }} testID="support-done" />
            </View>
          ) : (
            <>
              <Text style={styles.h1}>How can we help?</Text>
              <Text style={styles.sub}>
                {"Can't sign in, or something isn't working? Send us a message and we'll reply by email."}
              </Text>

              <SectionTitle style={{ marginTop: spacing.lg }}>Topic</SectionTitle>
              <View style={styles.chips}>
                {TOPICS.map((t) => (
                  <Chip
                    key={t.id}
                    label={t.label}
                    icon={t.icon}
                    selected={topic === t.id}
                    onPress={() => setTopic(t.id)}
                    testID={`support-topic-${t.id}`}
                  />
                ))}
              </View>

              <View style={{ marginTop: spacing.md }}>
                <Input label="Your name" placeholder="Your name" value={name} onChangeText={setName} testID="support-name" />
                <Input
                  label="Email"
                  placeholder="you@example.com"
                  autoCapitalize="none"
                  keyboardType="email-address"
                  value={email}
                  onChangeText={setEmail}
                  hint="We'll reply to this address."
                  testID="support-email"
                />
                <Input
                  label="Phone (optional)"
                  placeholder="+91 98765 43210"
                  keyboardType="phone-pad"
                  value={phone}
                  onChangeText={setPhone}
                  testID="support-phone"
                />
                <Input
                  label="Message"
                  placeholder={topic === "login" ? "Tell us the email you signed up with and what happens when you try to sign in." : "Describe the problem"}
                  multiline
                  textAlignVertical="top"
                  maxLength={5000}
                  value={message}
                  onChangeText={setMessage}
                  style={styles.message}
                  testID="support-message"
                />
              </View>

              {err ? <Text style={styles.err}>{err}</Text> : null}
              <Button label="Send message" icon="send-outline" onPress={submit} loading={sending} testID="support-submit" />

              {supportEmail ? (
                <Card style={{ marginTop: spacing.lg }} onPress={emailUs} testID="support-email-us">
                  <View style={styles.emailRow}>
                    <View style={styles.emailIcon}>
                      <Ionicons name="mail-outline" size={18} color={colors.primary} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.emailLabel}>Prefer email?</Text>
                      <Text style={styles.emailValue}>{supportEmail}</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
                  </View>
                </Card>
              ) : null}
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
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
  scroll: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl },
  h1: { fontSize: 26, fontWeight: "800", color: colors.text, letterSpacing: -0.5 },
  sub: { color: colors.textMuted, marginTop: 6, fontSize: 15, lineHeight: 21 },
  chips: { flexDirection: "row", flexWrap: "wrap" },
  message: { height: 140, paddingTop: 14, paddingBottom: 14 },
  err: { color: colors.danger, marginBottom: 8, fontSize: 13 },
  emailRow: { flexDirection: "row", alignItems: "center" },
  emailIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: colors.primaryTint,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  emailLabel: { fontSize: 13, color: colors.textMuted },
  emailValue: { fontSize: 15, fontWeight: "700", color: colors.text, marginTop: 2 },
  done: { alignItems: "center", paddingTop: spacing.xl },
  doneIcon: {
    width: 64,
    height: 64,
    borderRadius: radius.pill,
    backgroundColor: colors.primaryTint,
    alignItems: "center",
    justifyContent: "center",
  },
  doneTitle: { fontSize: 22, fontWeight: "800", color: colors.text, marginTop: spacing.md },
  doneBody: { fontSize: 15, color: colors.textMuted, textAlign: "center", marginTop: 8, lineHeight: 21 },
});
