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
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Button, Input, PromiseBanner } from "../../src/ui";
import { colors, spacing } from "../../src/theme";
import { useAuth } from "../../src/auth";
import { apiFetch } from "../../src/api";
import { isValidEmail } from "../../src/utils";

export default function Login() {
  const router = useRouter();
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [err, setErr] = useState("");

  const onForgot = async () => {
    if (!isValidEmail(email)) {
      setErr("Enter your email above, then tap Forgot password.");
      return;
    }
    setErr("");
    setResetting(true);
    try {
      await apiFetch("/auth/reset-password-request", {
        method: "POST",
        auth: false,
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });
      Alert.alert("Check your email", "If that email is registered, we've sent a password reset link.");
    } catch (e: any) {
      Alert.alert("Error", e.message || "Couldn't send reset link. Please try again.");
    } finally {
      setResetting(false);
    }
  };

  const onSubmit = async () => {
    if (!email || !password) {
      setErr("Please enter email and password");
      return;
    }
    setLoading(true);
    setErr("");
    try {
      await login(email.trim(), password);
      router.replace("/(app)/dashboard");
    } catch (e: any) {
      setErr(e.message || "Login failed");
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
          <Text style={styles.h1}>Welcome back</Text>
          <Text style={styles.sub}>Sign in to keep your commitments on track.</Text>
          <PromiseBanner />

          <View style={{ marginTop: spacing.xl }}>
            <Input
              label="Email"
              placeholder="you@example.com"
              autoCapitalize="none"
              keyboardType="email-address"
              value={email}
              onChangeText={setEmail}
              testID="login-email"
            />
            <Input
              label="Password"
              placeholder="Your password"
              secureTextEntry
              value={password}
              onChangeText={setPassword}
              testID="login-password"
            />
            <TouchableOpacity onPress={onForgot} disabled={resetting} style={styles.forgotWrap} testID="forgot-password">
              <Text style={styles.forgot}>{resetting ? "Sending…" : "Forgot password?"}</Text>
            </TouchableOpacity>
            {err ? <Text style={styles.err}>{err}</Text> : null}
            <Button label="Sign in" onPress={onSubmit} loading={loading} testID="login-submit" />
          </View>

          <TouchableOpacity
            onPress={() => router.push("/(auth)/signup")}
            style={{ alignItems: "center", marginTop: spacing.lg }}
            testID="login-to-signup"
          >
            <Text style={styles.link}>
              New here? <Text style={{ color: colors.primary, fontWeight: "700" }}>Create account</Text>
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() => router.push("/support")}
            style={{ alignItems: "center", marginTop: spacing.md }}
            testID="login-to-support"
          >
            <Text style={styles.link}>
              Trouble signing in? <Text style={{ color: colors.primary, fontWeight: "700" }}>Contact support</Text>
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
  logoWrap: {
    width: 64,
    height: 64,
    borderRadius: 18,
    overflow: "hidden",
    marginBottom: spacing.lg,
  },
  logoImg: { width: "100%", height: "100%" },
  h1: { fontSize: 32, fontWeight: "800", color: colors.text, letterSpacing: -0.5 },
  sub: { color: colors.textMuted, marginTop: 6, fontSize: 15 },
  err: { color: colors.danger, marginBottom: 8, fontSize: 13 },
  link: { color: colors.textMuted, fontSize: 14 },
  forgotWrap: { alignSelf: "flex-end", marginTop: -2, marginBottom: spacing.md },
  forgot: { color: colors.primary, fontWeight: "600", fontSize: 13 },
});
