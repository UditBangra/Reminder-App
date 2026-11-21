import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  TouchableOpacity,
  Image,
  TextInput,
  Linking,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Button, Input, PromiseBanner } from "../../src/ui";
import { colors, radius, spacing } from "../../src/theme";
import { useAuth } from "../../src/auth";
import { Ionicons } from "@expo/vector-icons";
import { COUNTRIES, phoneDigits, isValidPhoneForCountry, maxDigitsForCountry } from "../../src/countries";
import { isValidEmail } from "../../src/utils";

export default function Signup() {
  const router = useRouter();
  const { signup } = useAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [cc, setCc] = useState("+91");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [marketingConsent, setMarketingConsent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const onSubmit = async () => {
    setErr("");
    if (!name.trim()) return setErr("Please enter your name.");
    if (!isValidEmail(email)) return setErr("Please enter a valid email address.");
    if (!isValidPhoneForCountry(cc, phone)) {
      return setErr(cc === "+91" ? "Indian phone numbers must be exactly 10 digits." : "Please enter a valid phone number.");
    }
    if (password.length < 6) return setErr("Password must be at least 6 characters.");

    setLoading(true);
    try {
      await signup({
        email: email.trim(),
        phone: phoneDigits(phone),
        password,
        full_name: name.trim(),
        country_code: cc,
        marketing_consent: marketingConsent,
      });
      router.replace("/(app)/dashboard");
    } catch (e: any) {
      setErr(e.message || "Signup failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.logoWrap}>
            <Image source={require("../../assets/images/icon.png")} style={styles.logoImg} resizeMode="cover" />
          </View>
          <Text style={styles.h1}>Create account</Text>
          <Text style={styles.sub}>A calm, trusted system for all your reminders.</Text>
          <PromiseBanner />

          <View style={{ marginTop: spacing.xl }}>
            <Input label="Full name" placeholder="Your name" value={name} onChangeText={setName} testID="signup-name" />

            <Input
              label="Email"
              placeholder="you@example.com"
              autoCapitalize="none"
              keyboardType="email-address"
              value={email}
              onChangeText={setEmail}
              testID="signup-email"
            />

            <Text style={styles.fieldLabel}>Phone number</Text>
            <View style={styles.ccWrap}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                {COUNTRIES.map((c) => (
                  <TouchableOpacity
                    key={c.code}
                    onPress={() => setCc(c.code)}
                    style={[styles.ccPill, cc === c.code && styles.ccPillActive]}
                    testID={`cc-${c.code}`}
                  >
                    <Text style={{ color: cc === c.code ? "#fff" : colors.textMuted, fontSize: 12, fontWeight: "600" }}>
                      {c.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
            <View style={styles.phoneRow}>
              <View style={styles.ccBox}>
                <Text style={styles.ccBoxText}>{cc}</Text>
              </View>
              <TextInput
                style={styles.phoneInput}
                placeholder={cc === "+91" ? "10-digit number" : "Phone number"}
                placeholderTextColor={colors.placeholder}
                keyboardType="phone-pad"
                value={phone}
                onChangeText={(t) => setPhone(phoneDigits(t))}
                maxLength={maxDigitsForCountry(cc)}
                testID="signup-phone"
              />
            </View>

            <View style={{ height: spacing.md }} />
            <Input
              label="Password"
              placeholder="Min 6 characters"
              secureTextEntry
              value={password}
              onChangeText={setPassword}
              testID="signup-password"
            />

            <TouchableOpacity
              style={styles.consentRow}
              activeOpacity={0.7}
              onPress={() => setMarketingConsent((v) => !v)}
              testID="signup-marketing-consent"
            >
              <View style={[styles.checkbox, marketingConsent && styles.checkboxChecked]}>
                {marketingConsent ? <Ionicons name="checkmark" size={16} color="#fff" /> : null}
              </View>
              <Text style={styles.consentText}>
                I'd like to receive marketing communications, promotional emails, product updates, and
                other informational emails. <Text style={styles.consentOptional}>(Optional)</Text>
              </Text>
            </TouchableOpacity>

            {err ? <Text style={styles.err}>{err}</Text> : null}
            <Button label="Create account" onPress={onSubmit} loading={loading} testID="signup-submit" />

            <Text style={styles.legalText}>
              By creating an account, you agree to our{" "}
              <Text style={styles.legalLink} onPress={() => Linking.openURL("https://www.rymind.in/privacy-policy")}>
                Privacy Policy
              </Text>
              {" "}and{" "}
              <Text style={styles.legalLink} onPress={() => Linking.openURL("https://www.rymind.in/terms-of-service")}>
                Terms of Service
              </Text>
              .
            </Text>
          </View>

          <TouchableOpacity
            onPress={() => router.back()}
            style={{ alignItems: "center", marginTop: spacing.lg }}
            testID="signup-to-login"
          >
            <Text style={styles.link}>
              Have an account? <Text style={{ color: colors.primary, fontWeight: "700" }}>Sign in</Text>
            </Text>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  scroll: { padding: spacing.lg, paddingTop: spacing.xl },
  logoWrap: { width: 64, height: 64, borderRadius: 18, overflow: "hidden", marginBottom: spacing.lg },
  logoImg: { width: "100%", height: "100%" },
  h1: { fontSize: 32, fontWeight: "800", color: colors.text, letterSpacing: -0.5 },
  sub: { color: colors.textMuted, marginTop: 6, fontSize: 15 },
  err: { color: colors.danger, marginBottom: 8, fontSize: 13 },
  link: { color: colors.textMuted, fontSize: 14 },
  fieldLabel: { fontSize: 13, fontWeight: "600", color: colors.text, marginBottom: 6 },
  ccWrap: { flexDirection: "row", marginBottom: spacing.sm },
  ccPill: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    marginRight: 6,
  },
  ccPillActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  phoneRow: { flexDirection: "row", gap: 8 },
  ccBox: {
    height: 52,
    paddingHorizontal: 16,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
    alignItems: "center",
    justifyContent: "center",
  },
  ccBoxText: { color: colors.text, fontSize: 16, fontWeight: "700" },
  phoneInput: {
    flex: 1,
    height: 52,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 16,
    backgroundColor: colors.surface,
    fontSize: 16,
    color: colors.text,
  },
  legalText: { color: colors.textMuted, fontSize: 12, textAlign: "center", marginTop: 14, lineHeight: 18 },
  legalLink: { color: colors.primary, fontWeight: "600", textDecorationLine: "underline" },
  consentRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    marginTop: spacing.md,
    marginBottom: spacing.md,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
  },
  checkboxChecked: { backgroundColor: colors.primary, borderColor: colors.primary },
  consentText: { flex: 1, color: colors.textMuted, fontSize: 12.5, lineHeight: 18 },
  consentOptional: { color: colors.textMuted, fontStyle: "italic" },
});
