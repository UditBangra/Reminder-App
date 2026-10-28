import React, { useCallback, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Alert, ActivityIndicator, Linking, Modal, TextInput } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Application from "expo-application";
import Constants from "expo-constants";
import { useAuth } from "../../src/auth";
import { formatCredits, useBilling } from "../../src/billing";
import { apiFetch } from "../../src/api";
import { Button, Card, SectionTitle } from "../../src/ui";
import { colors, radius, spacing } from "../../src/theme";
import { VerifyModal, CountryCodeDropdown } from "../../src/VerificationGate";
import { phoneDigits, isValidPhoneForCountry, maxDigitsForCountry } from "../../src/countries";
import { isValidEmail } from "../../src/utils";

export default function Profile() {
  const { user, logout, refresh } = useAuth();
  const { billing, refresh: refreshBilling } = useBilling();
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const [resetting, setResetting] = useState(false);

  // Verified fields require OTP to change; unverified fields edit directly.
  const [verifyMode, setVerifyMode] = useState<"phone" | "email" | null>(null);
  const [editMode, setEditMode] = useState<"phone" | "email" | null>(null);
  const [editPhone, setEditPhone] = useState("");
  const [editCc, setEditCc] = useState("+91");
  const [editEmail, setEditEmail] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  // Keep the profile fresh on focus — the push token is saved after login, so a
  // cached user can otherwise show "Not set" even when notifications are enabled.
  useFocusEffect(useCallback(() => { refresh(); refreshBilling(); }, []));

  const openPhoneEdit = () => {
    if (!user) return;
    if (user.phone_verified) {
      setVerifyMode("phone");
    } else {
      setEditCc(user.country_code || "+91");
      setEditPhone(phoneDigits(user.phone || ""));
      setEditMode("phone");
    }
  };

  const openEmailEdit = () => {
    if (!user) return;
    if (user.email_verified) {
      setVerifyMode("email");
    } else {
      setEditEmail(user.email || "");
      setEditMode("email");
    }
  };

  const saveDirectEdit = async () => {
    if (editMode === "phone" && !isValidPhoneForCountry(editCc, editPhone)) {
      return Alert.alert("Invalid phone", editCc === "+91" ? "Indian phone numbers must be exactly 10 digits." : "Please enter a valid phone number.");
    }
    if (editMode === "email" && !isValidEmail(editEmail)) {
      return Alert.alert("Invalid email", "Please enter a valid email address.");
    }
    setSavingEdit(true);
    try {
      const body =
        editMode === "phone"
          ? { phone: phoneDigits(editPhone), country_code: editCc }
          : { email: editEmail.trim().toLowerCase() };
      await apiFetch("/auth/profile", { method: "PATCH", body: JSON.stringify(body) });
      await refresh();
      setEditMode(null);
    } catch (e: any) {
      Alert.alert("Error", e.message || "Couldn't save. Please try again.");
    } finally {
      setSavingEdit(false);
    }
  };

  const requestReset = async () => {
    if (!user?.email) {
      Alert.alert("Error", "No email associated with this account.");
      return;
    }
    setResetting(true);
    try {
      await apiFetch("/auth/reset-password-request", {
        method: "POST",
        body: JSON.stringify({ email: user.email }),
      });
      Alert.alert("Link sent", "A password reset link has been sent to your email.");
    } catch (e: any) {
      Alert.alert("Error", e.message || "Failed to request password reset.");
    } finally {
      setResetting(false);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={["top"]}>
      <ScrollView contentContainerStyle={{ padding: spacing.lg }}>
        <Text style={styles.title}>Profile</Text>

        <Card style={{ marginTop: spacing.lg, alignItems: "center", paddingVertical: spacing.xl }}>
          <View style={styles.avatar}>
            <Text style={{ color: "#fff", fontSize: 28, fontWeight: "800" }}>
              {(user?.full_name || "U").slice(0, 1).toUpperCase()}
            </Text>
          </View>
          <Text style={styles.name}>{user?.full_name}</Text>
          <Text style={styles.meta}>{user?.email}</Text>
          <Text style={styles.meta}>{user?.country_code} {user?.phone}</Text>
        </Card>

        <View style={{ marginTop: spacing.lg }}>
          <SectionTitle>Account</SectionTitle>
          <Card>
            <TouchableOpacity onPress={openEmailEdit} activeOpacity={0.7} testID="edit-email-btn">
              <Row icon="mail-outline" label="Email" rightIcon="create-outline" />
            </TouchableOpacity>
            <Divider />
            <TouchableOpacity onPress={openPhoneEdit} activeOpacity={0.7} testID="edit-phone-btn">
              <Row icon="call-outline" label="Phone" rightIcon="create-outline" />
            </TouchableOpacity>
            <Divider />
            <Row icon="notifications-outline" label="Notifications" value={user?.expo_push_token ? "Enabled" : "Not set"} />
            <Divider />
            <Row icon="shield-checkmark-outline" label="Security" value="Password protected" />
            <Divider />
            <TouchableOpacity onPress={requestReset} activeOpacity={0.7} testID="reset-password-btn">
              {resetting ? (
                <Row icon="key-outline" label="Reset password" value="Sending..." />
              ) : (
                <Row icon="key-outline" label="Reset password" chevron />
              )}
            </TouchableOpacity>
            <Divider />
            <Row icon="globe-outline" label="Region" value={user?.country_code || "+91"} />
          </Card>
        </View>

        <View style={{ marginTop: spacing.lg }}>
          <SectionTitle>Plan and credits</SectionTitle>
          <Card>
            <TouchableOpacity onPress={() => router.push("/plans")} activeOpacity={0.7} testID="profile-plans">
              <Row
                icon="ribbon-outline"
                label="Plan"
                value={billing ? billing.plans.find((p) => p.id === billing.plan)?.name || "Free" : ""}
                chevron
              />
            </TouchableOpacity>
            <Divider />
            <TouchableOpacity onPress={() => router.push("/plans")} activeOpacity={0.7} testID="profile-credits">
              <Row
                icon="wallet-outline"
                label="Credits"
                value={billing ? formatCredits(billing.credits) : ""}
                valueColor={billing && billing.credits > 0 ? colors.primary : undefined}
                chevron
              />
            </TouchableOpacity>
            <Divider />
            <TouchableOpacity onPress={() => router.push("/credits")} activeOpacity={0.7} testID="profile-credit-history">
              <Row icon="receipt-outline" label="Credit history" chevron />
            </TouchableOpacity>
          </Card>
        </View>

        <View style={{ marginTop: spacing.lg }}>
          <SectionTitle>Rymind Web</SectionTitle>
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={() => router.push("/linked-devices")}
            testID="open-linked-devices"
          >
            <Card>
              <Row
                icon="qr-code-outline"
                label="Linked devices"
                value="Scan to sign in"
                chevron
              />
            </Card>
          </TouchableOpacity>
        </View>

        <View style={{ marginTop: spacing.xl }}>
          <Button
            label="Sign out"
            variant="secondary"
            icon="log-out-outline"
            onPress={async () => {
              await logout();
              router.replace("/(auth)/login");
            }}
            testID="logout-btn"
          />
        </View>

        <View style={{ marginTop: spacing.lg }}>
          <SectionTitle>Legal</SectionTitle>
          <Card>
            <TouchableOpacity activeOpacity={0.7} onPress={() => Linking.openURL("https://www.rymind.in/privacy-policy")} testID="open-privacy-policy">
              <Row icon="document-text-outline" label="Privacy Policy" chevron />
            </TouchableOpacity>
            <Divider />
            <TouchableOpacity activeOpacity={0.7} onPress={() => Linking.openURL("https://www.rymind.in/terms-of-service")} testID="open-terms">
              <Row icon="reader-outline" label="Terms of Service" chevron />
            </TouchableOpacity>
          </Card>
        </View>

        {/* Danger Zone — Delete Account */}
        <View style={{ marginTop: spacing.xl }}>
          <SectionTitle>Danger Zone</SectionTitle>
          <Card style={styles.dangerCard}>
            <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 10 }}>
              <View style={styles.dangerIcon}>
                <Ionicons name="warning" size={18} color={colors.danger} />
              </View>
              <Text style={styles.dangerTitle}>Delete Account</Text>
            </View>
            <Text style={styles.dangerDesc}>
              Permanently delete your account and all associated data including reminders, contacts, history, and linked web sessions. This action cannot be undone.
            </Text>
            <TouchableOpacity
              style={[styles.dangerBtn, deleting && { opacity: 0.5 }]}
              disabled={deleting}
              onPress={() => {
                Alert.alert(
                  "Delete your account?",
                  "This will permanently delete your account, all reminders, contacts, history, and linked devices. This action CANNOT be undone.",
                  [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Delete permanently",
                      style: "destructive",
                      onPress: async () => {
                        setDeleting(true);
                        try {
                          await apiFetch("/auth/account", { method: "DELETE" });
                          await logout();
                          router.replace("/(auth)/login");
                          Alert.alert("Account deleted", "Your account and all data have been permanently removed.");
                        } catch (e: any) {
                          Alert.alert("Error", e.message || "Failed to delete account. Please try again.");
                        } finally {
                          setDeleting(false);
                        }
                      },
                    },
                  ]
                );
              }}
              testID="delete-account-btn"
            >
              {deleting ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <Ionicons name="trash" size={16} color="#fff" style={{ marginRight: 8 }} />
                  <Text style={styles.dangerBtnText}>Delete my account</Text>
                </>
              )}
            </TouchableOpacity>
          </Card>
        </View>

        <Text style={styles.footer}>Rymind · v{Application.nativeApplicationVersion || Constants.expoConfig?.version || ""}</Text>
      </ScrollView>

      {/* Verified field change → OTP required */}
      {verifyMode && (
        <VerifyModal
          key={verifyMode}
          visible
          mode={verifyMode}
          dismissible
          initialPhone={user?.phone}
          initialCc={user?.country_code}
          initialEmail={user?.email}
          onClose={() => setVerifyMode(null)}
          onVerified={async () => { await refresh(); setVerifyMode(null); }}
        />
      )}

      {/* Unverified field → direct edit, no OTP */}
      <Modal transparent visible={!!editMode} animationType="fade" onRequestClose={() => setEditMode(null)}>
        <View style={styles.editOverlay}>
          <View style={styles.editCard}>
            <Text style={styles.editTitle}>{editMode === "phone" ? "Edit phone number" : "Edit email"}</Text>
            {editMode === "phone" ? (
              <View style={{ flexDirection: "row", gap: 8 }}>
                <CountryCodeDropdown value={editCc} onChange={setEditCc} />
                <TextInput
                  style={[styles.editInput, { flex: 1 }]}
                  placeholder={editCc === "+91" ? "10-digit number" : "Phone number"}
                  placeholderTextColor={colors.placeholder}
                  keyboardType="phone-pad"
                  value={editPhone}
                  onChangeText={(t) => setEditPhone(phoneDigits(t))}
                  maxLength={maxDigitsForCountry(editCc)}
                  testID="profile-edit-phone"
                />
              </View>
            ) : (
              <TextInput
                style={styles.editInput}
                placeholder="you@example.com"
                placeholderTextColor={colors.placeholder}
                autoCapitalize="none"
                keyboardType="email-address"
                value={editEmail}
                onChangeText={setEditEmail}
                testID="profile-edit-email"
              />
            )}
            <Button label="Save" onPress={saveDirectEdit} loading={savingEdit} style={{ marginTop: spacing.lg }} testID="profile-edit-save" />
            <TouchableOpacity onPress={() => setEditMode(null)} style={{ alignItems: "center", marginTop: 12 }}>
              <Text style={{ color: colors.textMuted }}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function Row({ icon, label, value, chevron, valueColor, rightIcon }: { icon: any; label: string; value?: string; chevron?: boolean; valueColor?: string; rightIcon?: any }) {
  return (
    <View style={rowStyles.row}>
      <View style={rowStyles.iconWrap}>
        <Ionicons name={icon} size={18} color={colors.primary} />
      </View>
      <Text style={{ flex: 1, fontSize: 15, color: colors.text, fontWeight: "600" }}>{label}</Text>
      {value ? <Text style={{ color: valueColor || colors.textMuted, fontSize: 13, fontWeight: valueColor ? "700" : "400", marginRight: chevron ? 6 : 0 }}>{value}</Text> : null}
      {rightIcon ? <Ionicons name={rightIcon} size={18} color={colors.primary} /> : null}
      {chevron ? <Ionicons name="chevron-forward" size={18} color={colors.textMuted} /> : null}
    </View>
  );
}
function Divider() {
  return <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 6 }} />;
}

const rowStyles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 10 },
  iconWrap: {
    width: 34, height: 34, borderRadius: 10, backgroundColor: colors.primaryTint,
    alignItems: "center", justifyContent: "center", marginRight: 12,
  },
});

const styles = StyleSheet.create({
  editOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "center", padding: spacing.lg },
  editCard: { backgroundColor: colors.surface, borderRadius: radius.xl, padding: spacing.lg, width: "100%", maxWidth: 420, alignSelf: "center" },
  editTitle: { fontSize: 18, fontWeight: "800", color: colors.text, marginBottom: spacing.md },
  editInput: {
    height: 52, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    paddingHorizontal: 16, backgroundColor: colors.surface, fontSize: 16, color: colors.text,
  },
  title: { fontSize: 28, fontWeight: "800", color: colors.text, letterSpacing: -0.5 },
  avatar: {
    width: 72, height: 72, borderRadius: 36, backgroundColor: colors.primary,
    alignItems: "center", justifyContent: "center", marginBottom: 12,
  },
  name: { fontSize: 20, fontWeight: "800", color: colors.text },
  meta: { color: colors.textMuted, fontSize: 13, marginTop: 2 },
  footer: { color: colors.textMuted, fontSize: 12, textAlign: "center", marginTop: spacing.xxl },
  dangerCard: {
    borderWidth: 1,
    borderColor: "#EDD2D2",
    backgroundColor: "#FBF4F3",
    // Opaque tints + no elevation: Android renders its shadow through
    // translucent card backgrounds, which looked like a dark thick border
    elevation: 0,
    shadowOpacity: 0,
  },
  dangerIcon: {
    width: 34, height: 34, borderRadius: 10,
    backgroundColor: "#F3DEDE",
    alignItems: "center", justifyContent: "center", marginRight: 12,
  },
  dangerTitle: {
    fontSize: 15, fontWeight: "700", color: colors.danger,
  },
  dangerDesc: {
    fontSize: 12, color: colors.textMuted, lineHeight: 18, marginBottom: 14,
  },
  dangerBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.danger,
    paddingVertical: 12,
    borderRadius: radius.md,
  },
  dangerBtnText: {
    color: "#fff", fontSize: 14, fontWeight: "700",
  },
});
