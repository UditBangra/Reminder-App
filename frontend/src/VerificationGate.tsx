import React, { useEffect, useState } from "react";
import { View, Text, TextInput, StyleSheet, Modal, TouchableOpacity, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, radius, spacing } from "./theme";
import { apiFetch } from "./api";
import { useAuth } from "./auth";
import { COUNTRIES, phoneDigits, isValidPhoneForCountry, maxDigitsForCountry } from "./countries";
import { isValidEmail } from "./utils";

type Mode = "phone" | "email";

function daysSince(iso?: string): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return 0;
  return (Date.now() - t) / 86400000;
}

/* ---------- Country code dropdown ---------- */
export function CountryCodeDropdown({ value, onChange }: { value: string; onChange: (cc: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <TouchableOpacity style={s.ccTrigger} activeOpacity={0.85} onPress={() => setOpen(true)} testID="verify-cc">
        <Text style={s.ccTriggerText}>{value}</Text>
        <Ionicons name="chevron-down" size={14} color={colors.textMuted} />
      </TouchableOpacity>
      <Modal transparent animationType="fade" visible={open} onRequestClose={() => setOpen(false)}>
        <TouchableOpacity style={s.ccOverlay} activeOpacity={1} onPress={() => setOpen(false)}>
          <View style={s.ccMenu}>
            {COUNTRIES.map((c) => {
              const sel = c.code === value;
              return (
                <TouchableOpacity
                  key={c.code}
                  style={[s.ccItem, sel && { backgroundColor: colors.primaryTint }]}
                  onPress={() => { onChange(c.code); setOpen(false); }}
                  testID={`verify-cc-${c.code}`}
                >
                  <Text style={{ color: sel ? colors.primary : colors.text, fontSize: 15, fontWeight: sel ? "700" : "500" }}>{c.label}</Text>
                  {sel && <Ionicons name="checkmark" size={16} color={colors.primary} />}
                </TouchableOpacity>
              );
            })}
          </View>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

/* ---------- Reusable verify modal (phone or email, OTP) ---------- */
export function VerifyModal({
  visible,
  mode,
  dismissible,
  initialPhone,
  initialCc,
  initialEmail,
  onClose,
  onVerified,
  onSkip,
}: {
  visible: boolean;
  mode: Mode;
  dismissible: boolean;
  initialPhone?: string;
  initialCc?: string;
  initialEmail?: string;
  onClose: () => void;
  onVerified: () => void;
  /** Mandatory gate only: offered after the code couldn't be sent, so an SMS/email outage never locks people out. */
  onSkip?: () => void;
}) {
  const [cc, setCc] = useState(initialCc || "+91");
  const [phone, setPhone] = useState(phoneDigits(initialPhone || ""));
  const [email, setEmail] = useState(initialEmail || "");
  const [otpSent, setOtpSent] = useState(false);
  const [otp, setOtp] = useState("");
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [err, setErr] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const [sendFailed, setSendFailed] = useState(false);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const validate = (): string | null => {
    if (mode === "phone") {
      if (!isValidPhoneForCountry(cc, phone))
        return cc === "+91" ? "Indian phone numbers must be exactly 10 digits." : "Please enter a valid phone number.";
    } else if (!isValidEmail(email)) {
      return "Please enter a valid email address.";
    }
    return null;
  };

  const sendOtp = async () => {
    const v = validate();
    if (v) return setErr(v);
    setErr("");
    setSending(true);
    try {
      const body =
        mode === "phone"
          ? { target: "phone", value: `${cc}${phoneDigits(phone)}`, country_code: cc }
          : { target: "email", value: email.trim().toLowerCase() };
      await apiFetch("/auth/send-code", { method: "POST", auth: false, body: JSON.stringify(body) });
      setOtpSent(true);
      setCooldown(60);
    } catch (e: any) {
      setErr(e.message || "Failed to send code.");
      // Our side (or the SMS/email provider) failed, not the user's input.
      if (!e?.status || e.status >= 500) setSendFailed(true);
    } finally {
      setSending(false);
    }
  };

  const verify = async () => {
    if (otp.trim().length !== 6) return setErr("Enter the 6-digit code.");
    setErr("");
    setVerifying(true);
    try {
      await apiFetch(mode === "phone" ? "/auth/verify-phone" : "/auth/verify-email", {
        method: "POST",
        body: JSON.stringify(
          mode === "phone"
            ? { phone: phoneDigits(phone), country_code: cc, code: otp.trim() }
            : { email: email.trim().toLowerCase(), code: otp.trim() }
        ),
      });
      onVerified();
    } catch (e: any) {
      setErr(e.message || "Verification failed.");
    } finally {
      setVerifying(false);
    }
  };

  const resetOtp = () => {
    if (otpSent) {
      setOtpSent(false);
      setOtp("");
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => dismissible && onClose()}>
      <View style={s.overlay}>
        <View style={s.card}>
          <View style={s.iconWrap}>
            <Ionicons name={mode === "phone" ? "call" : "mail"} size={26} color={colors.primary} />
          </View>
          <Text style={s.title}>{mode === "phone" ? "Verify your phone number" : "Verify your email"}</Text>
          <Text style={s.msg}>
            {mode === "phone"
              ? "You must verify your phone number to continue using the app."
              : "You must verify your email to continue using the app."}
          </Text>

          {mode === "phone" ? (
            <>
              <Text style={s.label}>Phone number</Text>
              <View style={s.phoneRow}>
                <CountryCodeDropdown value={cc} onChange={(v) => { setCc(v); resetOtp(); }} />
                <TextInput
                  style={s.phoneInput}
                  placeholder={cc === "+91" ? "10-digit number" : "Phone number"}
                  placeholderTextColor={colors.placeholder}
                  keyboardType="phone-pad"
                  value={phone}
                  onChangeText={(t) => { setPhone(phoneDigits(t)); resetOtp(); }}
                  maxLength={maxDigitsForCountry(cc)}
                  editable={!verifying}
                  testID="verify-phone-input"
                />
              </View>
            </>
          ) : (
            <>
              <Text style={s.label}>Email</Text>
              <TextInput
                style={s.input}
                placeholder="you@example.com"
                placeholderTextColor={colors.placeholder}
                autoCapitalize="none"
                keyboardType="email-address"
                value={email}
                onChangeText={(t) => { setEmail(t); resetOtp(); }}
                editable={!verifying}
                testID="verify-email-input"
              />
            </>
          )}

          {otpSent && (
            <>
              <Text style={[s.label, { marginTop: spacing.md }]}>Enter the 6-digit code</Text>
              <TextInput
                style={[s.input, s.otpInput]}
                placeholder="------"
                placeholderTextColor={colors.placeholder}
                keyboardType="number-pad"
                maxLength={6}
                value={otp}
                onChangeText={(t) => setOtp(t.replace(/[^0-9]/g, ""))}
                testID="verify-otp-input"
              />
            </>
          )}

          {err ? <Text style={s.err}>{err}</Text> : null}

          {!otpSent ? (
            <TouchableOpacity style={s.primaryBtn} onPress={sendOtp} disabled={sending} testID="verify-send-otp">
              {sending ? <ActivityIndicator color="#fff" /> : <Text style={s.primaryBtnText}>Send OTP</Text>}
            </TouchableOpacity>
          ) : (
            <>
              <TouchableOpacity style={s.primaryBtn} onPress={verify} disabled={verifying} testID="verify-confirm">
                {verifying ? <ActivityIndicator color="#fff" /> : <Text style={s.primaryBtnText}>Verify</Text>}
              </TouchableOpacity>
              <TouchableOpacity onPress={sendOtp} disabled={cooldown > 0 || sending} style={{ marginTop: 12, alignItems: "center" }} testID="verify-resend">
                <Text style={{ color: cooldown > 0 ? colors.textMuted : colors.primary, fontWeight: "600", fontSize: 13 }}>
                  {cooldown > 0 ? `Resend code in ${cooldown}s` : "Resend code"}
                </Text>
              </TouchableOpacity>
            </>
          )}

          {dismissible && (
            <TouchableOpacity onPress={onClose} style={{ marginTop: 14, alignItems: "center" }} testID="verify-cancel">
              <Text style={{ color: colors.textMuted, fontSize: 14 }}>Cancel</Text>
            </TouchableOpacity>
          )}
          {!dismissible && onSkip && sendFailed && (
            <TouchableOpacity onPress={onSkip} style={{ marginTop: 14, alignItems: "center" }} testID="verify-skip">
              <Text style={{ color: colors.textMuted, fontSize: 14 }}>Verify later</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </Modal>
  );
}

/* ---------- Mandatory gate, driven by account age + verified flags ---------- */
// "Verify later" lasts until the app is restarted.
let skippedThisSession: Mode | null = null;

export function VerificationGate() {
  const { user, refresh } = useAuth();
  const [, force] = useState(0);
  if (!user) return null;

  const days = daysSince(user.created_at);
  const needPhone = !user.phone_verified && days >= 3;
  const needEmail = !user.email_verified && days >= 6;
  const mode: Mode | null = needPhone ? "phone" : needEmail ? "email" : null;
  if (!mode || skippedThisSession === mode) return null;

  return (
    <VerifyModal
      key={mode}
      visible
      mode={mode}
      dismissible={false}
      initialPhone={user.phone}
      initialCc={user.country_code}
      initialEmail={user.email}
      onClose={() => {}}
      onVerified={() => { refresh(); }}
      onSkip={() => { skippedThisSession = mode; force((n) => n + 1); }}
    />
  );
}

const s = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "center", padding: spacing.lg },
  card: { backgroundColor: colors.surface, borderRadius: radius.xl, padding: spacing.lg, width: "100%", maxWidth: 420, alignSelf: "center" },
  iconWrap: {
    width: 56, height: 56, borderRadius: 28, backgroundColor: colors.primaryTint,
    alignItems: "center", justifyContent: "center", alignSelf: "center", marginBottom: spacing.md,
  },
  title: { fontSize: 20, fontWeight: "800", color: colors.text, textAlign: "center" },
  msg: { fontSize: 13, color: colors.textMuted, textAlign: "center", marginTop: 6, marginBottom: spacing.lg, lineHeight: 19 },
  label: { fontSize: 13, fontWeight: "600", color: colors.text, marginBottom: 6 },
  input: {
    height: 52, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    paddingHorizontal: 16, backgroundColor: colors.surface, fontSize: 16, color: colors.text,
  },
  otpInput: { textAlign: "center", letterSpacing: 8, fontSize: 20, fontWeight: "700" },
  phoneRow: { flexDirection: "row", gap: 8 },
  phoneInput: {
    flex: 1, height: 52, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    paddingHorizontal: 16, backgroundColor: colors.surface, fontSize: 16, color: colors.text,
  },
  err: { color: colors.danger, fontSize: 13, marginTop: 10 },
  primaryBtn: {
    height: 52, borderRadius: radius.pill, backgroundColor: colors.primary,
    alignItems: "center", justifyContent: "center", marginTop: spacing.lg,
  },
  primaryBtnText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  ccTrigger: {
    flexDirection: "row", alignItems: "center", gap: 6, height: 52, paddingHorizontal: 14,
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.surfaceAlt,
  },
  ccTriggerText: { color: colors.text, fontSize: 16, fontWeight: "700" },
  ccOverlay: { flex: 1, backgroundColor: colors.overlay, justifyContent: "center", padding: spacing.lg },
  ccMenu: { backgroundColor: colors.surface, borderRadius: radius.lg, paddingVertical: 6, width: "100%", maxWidth: 360, alignSelf: "center" },
  ccItem: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.md, paddingVertical: 13 },
});
