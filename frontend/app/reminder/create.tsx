import React, { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ScrollView,
  Switch,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  Alert,
  Modal,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Button, Card, Chip, Input, SectionTitle } from "../../src/ui";
import { PickerSheet } from "../../src/PickerSheet";
import { colors, radius, spacing } from "../../src/theme";
import { apiFetch } from "../../src/api";
import { useAuth } from "../../src/auth";
import { formatCredits, useBilling } from "../../src/billing";
import { combineDateTime, fmtDate, isValidEmail } from "../../src/utils";
import { maybeAskForRating, recordReminderCreated } from "../../src/rating";
import { isValidPhoneNumber } from "../../src/countries";

type Channel = "push" | "whatsapp" | "email" | "sms";
type Contact = { id: string; name: string; phone?: string; email?: string };
type RepeatUnit = "min" | "hour" | "day" | "week" | "month" | "year";

const STEPS = ["Event", "Timing", "Delivery", "Target"];

const UNIT_HOURS: Record<RepeatUnit, number> = {
  min: 1 / 60,
  hour: 1,
  day: 24,
  week: 168,
  month: 720,
  year: 8760,
};

const UNIT_OPTIONS: { value: RepeatUnit; label: string }[] = [
  { value: "min", label: "Minutes" },
  { value: "hour", label: "Hours" },
  { value: "day", label: "Days" },
  { value: "week", label: "Weekly" },
  { value: "month", label: "Monthly" },
  { value: "year", label: "Yearly" },
];

// Per-unit interval limits (all equal ≤ 5 years; backend caps at 43800 hours)
const UNIT_MAX: Record<RepeatUnit, { max: number; label: string }> = {
  min: { max: 10080, label: "minutes (1 week)" },
  hour: { max: 8760, label: "hours (1 year)" },
  day: { max: 365, label: "days (1 year)" },
  week: { max: 52, label: "weeks (1 year)" },
  month: { max: 24, label: "months (2 years)" },
  year: { max: 5, label: "years" },
};

const MAX_REPEAT_COUNT = 50;

const digitsOnly = (t: string) => t.replace(/[^0-9]/g, "");

export default function CreateReminder() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { prefill } = useLocalSearchParams<{ prefill?: string }>();
  const { user } = useAuth();
  const [step, setStep] = useState(0);

  // Step 1
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");

  // Step 2
  const now = useMemo(() => new Date(Date.now() + 5 * 60 * 1000), []);
  const [date, setDate] = useState<Date>(now);
  const [time, setTime] = useState<Date>(now);
  const [showDate, setShowDate] = useState(false);
  const [showTime, setShowTime] = useState(false);
  // Repeat is optional: toggle OFF = fire once, count "0" = unlimited
  const [repeatEnabled, setRepeatEnabled] = useState(false);
  const [repeatCount, setRepeatCount] = useState("");
  const [repeatUnit, setRepeatUnit] = useState<RepeatUnit>("day");
  const [repeatValue, setRepeatValue] = useState("1");

  // Step 3
  const [channels, setChannels] = useState<Channel[]>(["push"]);

  // Step 4
  const [isSelf, setIsSelf] = useState(true);
  const [targetMode, setTargetMode] = useState<"existing" | "new" | null>(null);
  const [targetName, setTargetName] = useState("");
  const [targetPhone, setTargetPhone] = useState("");
  const [targetEmail, setTargetEmail] = useState("");
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactId, setContactId] = useState<string | null>(null);
  const [savePerson, setSavePerson] = useState(false);

  const [saving, setSaving] = useState(false);
  const [savedSheet, setSavedSheet] = useState(false);
  const [isReschedule, setIsReschedule] = useState(false);

  // Free plan = app notifications only; WhatsApp/SMS/email need credits.
  const { billing, refresh: refreshBilling } = useBilling();
  const isFree = billing?.plan === "free";
  const rates = billing?.rates;
  const costLabel = (n?: number) => (n === undefined ? undefined : `${formatCredits(n)} credits per message`);

  const showPlansPrompt = (title: string, body: string) =>
    Alert.alert(title, body, [
      { text: "Not now", style: "cancel" },
      { text: "See plans", onPress: () => router.push("/plans") },
    ]);

  // A rescheduled reminder may carry paid channels from before; drop them on Free.
  useEffect(() => {
    if (!isFree) return;
    setChannels((prev) => {
      const kept = prev.filter((c) => c === "push");
      return kept.length ? kept : ["push"];
    });
  }, [isFree]);

  useEffect(() => {
    (async () => {
      try {
        setContacts(await apiFetch<Contact[]>("/contacts"));
      } catch {}
    })();
  }, []);

  // Prefill from an existing reminder (Reschedule flow)
  useEffect(() => {
    if (!prefill) return;
    (async () => {
      try {
        const r = await apiFetch<any>(`/reminders/${prefill}`);
        setIsReschedule(true);
        setTitle(r.title || "");
        setMessage(r.message || "");
        const prefillChannels = (r.channels || ["push"]) as Channel[];
        setChannels(isFree ? (["push"] as Channel[]) : prefillChannels);
        const rc = r.repeat_count ?? 1;
        setRepeatEnabled(rc === -1 || rc > 1);
        setRepeatCount(rc === -1 ? "0" : rc > 1 ? String(rc) : "");
        const hours = r.repeat_interval_hours ?? 24;
        if (hours < 1) {
          setRepeatUnit("min");
          setRepeatValue(String(Math.round(hours * 60)));
        } else if (hours % 8760 === 0) {
          setRepeatUnit("year");
          setRepeatValue(String(hours / 8760));
        } else if (hours % 720 === 0) {
          setRepeatUnit("month");
          setRepeatValue(String(hours / 720));
        } else if (hours % 168 === 0) {
          setRepeatUnit("week");
          setRepeatValue(String(hours / 168));
        } else if (hours % 24 === 0) {
          setRepeatUnit("day");
          setRepeatValue(String(hours / 24));
        } else {
          setRepeatUnit("hour");
          setRepeatValue(String(hours));
        }
        const t = r.target || {};
        setIsSelf(!!t.is_self);
        setTargetName(t.name || "");
        setTargetPhone(t.phone || "");
        setTargetEmail(t.email || "");
        if (r.contact_id) setContactId(r.contact_id);
        if (!t.is_self) setTargetMode(r.contact_id ? "existing" : "new");
      } catch (e) {
        // silently ignore — user will fill manually
      }
    })();
  }, [prefill]);

  const toggleChannel = (c: Channel) => {
    if (isFree && c !== "push" && !channels.includes(c)) {
      return showPlansPrompt(
        "Credits needed",
        "WhatsApp, SMS and email come with the credit packs. Buy credits to use them, or keep App Notification, which is free."
      );
    }
    setChannels((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
  };

  const computeRepeatHours = () => (parseFloat(repeatValue) || 0) * UNIT_HOURS[repeatUnit];

  // One phone number serves both WhatsApp and SMS — label reflects what's selected
  const phoneFieldLabel = (() => {
    const wa = channels.includes("whatsapp");
    const sms = channels.includes("sms");
    if (wa && sms) return "Phone number (WhatsApp/SMS)";
    if (wa) return "Phone number (WhatsApp)";
    if (sms) return "Phone number (SMS)";
    return "Phone number";
  })();

  // Push/WhatsApp/SMS all need the recipient's number; email-only does not.
  const recipientNeedsPhone =
    channels.includes("push") || channels.includes("whatsapp") || channels.includes("sms");

  const selectedContact = contacts.find((c) => c.id === contactId) || null;

  const chooseExisting = () => {
    if (targetMode === "existing") return;
    setTargetMode("existing");
    setSavePerson(false);
    setContactId(null);
    setTargetName("");
    setTargetPhone("");
    setTargetEmail("");
  };
  const chooseNew = () => {
    if (targetMode === "new") return;
    setTargetMode("new");
    setContactId(null);
    setTargetName("");
    setTargetPhone("");
    setTargetEmail("");
  };

  const finalDateTime = combineDateTime(date, time);

  const validate = (): string | null => {
    if (step === 0) {
      if (!title.trim()) return "Please enter a title.";
    } else if (step === 1) {
      if (finalDateTime.getTime() < Date.now() - 60000) {
        return "Scheduled time is in the past.";
      }
      if (repeatEnabled) {
        const rc = repeatCount.trim();
        if (rc === "") return "Enter how many times to repeat (0 for unlimited).";
        const n = parseInt(rc);
        if (isNaN(n) || n < 0) return "Repeat count must be 0 or a positive number.";
        if (n > MAX_REPEAT_COUNT) return `Repeat count can't exceed ${MAX_REPEAT_COUNT}.`;
        const iv = repeatValue.trim();
        if (iv === "") return "Enter the repeat interval.";
        const v = parseInt(iv);
        if (isNaN(v) || v < 1) return "Repeat interval must be at least 1.";
        const { max, label } = UNIT_MAX[repeatUnit];
        if (v > max) return `Repeat interval can't exceed ${max} ${label}.`;
      }
    } else if (step === 2) {
      if (channels.length === 0) return "Select at least one delivery method.";
    } else if (step === 3) {
      if (!isSelf) {
        if (!targetMode) return "Choose an existing contact or a new person.";
        if (targetMode === "existing") {
          if (!contactId) return "Please select a contact.";
          if (channels.includes("email") && !(selectedContact?.email || "").trim()) {
            return "This contact has no email saved. Edit the contact or remove the Email channel.";
          }
        } else {
          if (!targetName.trim()) return "Enter contact name.";
          // Required whenever a phone-based channel (incl. App Notification) is selected
          if (recipientNeedsPhone) {
            if (!targetPhone.trim()) return "Phone number is required.";
            if (!isValidPhoneNumber(targetPhone)) return "Enter a valid phone number.";
          }
          if (channels.includes("email")) {
            if (!targetEmail.trim()) return "Email required.";
            if (!isValidEmail(targetEmail)) return "Enter a valid email address.";
          } else if (targetEmail.trim() && !isValidEmail(targetEmail)) {
            return "Enter a valid email address.";
          }
        }
      }
    }
    return null;
  };

  const next = () => {
    const err = validate();
    if (err) return Alert.alert("Check inputs", err);
    setStep((s) => Math.min(3, s + 1));
  };
  const back = () => setStep((s) => Math.max(0, s - 1));

  const submit = async () => {
    const err = validate();
    if (err) return Alert.alert("Check inputs", err);
    setSaving(true);
    try {
      // Toggle off = one-time reminder; "0" = unlimited (-1 for the API)
      const rcStr = repeatCount.trim();
      const rcNum = !repeatEnabled || rcStr === "" ? 1 : parseInt(rcStr) === 0 ? -1 : parseInt(rcStr) || 1;
      const body = {
        title: title.trim(),
        message: message.trim(),
        scheduled_at: finalDateTime.toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        channels,
        repeat_count: rcNum,
        // Toggle off → ignore whatever is in the interval box (it isn't validated then)
        repeat_interval_hours: repeatEnabled ? computeRepeatHours() : 24,
        lead_minutes: 0,
        target: {
          is_self: isSelf,
          name: isSelf ? null : targetName.trim() || null,
          phone: isSelf ? null : targetPhone.trim() || null,
          email: isSelf ? null : targetEmail.trim() || null,
        },
        contact_id: contactId,
      };
      await apiFetch("/reminders", { method: "POST", body: JSON.stringify(body) });

      if (!isSelf && savePerson && !contactId) {
        try {
          await apiFetch("/contacts", {
            method: "POST",
            body: JSON.stringify({
              name: targetName.trim(),
              phone: targetPhone.trim(),
              email: targetEmail.trim() || null,
            }),
          });
        } catch {}
      }
      recordReminderCreated();
      refreshBilling();
      setSavedSheet(true);
    } catch (e: any) {
      if (isFree) showPlansPrompt("Upgrade to continue", e.message);
      else Alert.alert("Error", e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      {/* Header */}
      <View style={styles.topRow}>
        <TouchableOpacity onPress={() => (step === 0 ? router.back() : back())} testID="wizard-back">
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.topTitle}>{isReschedule ? "Reschedule reminder" : "New reminder"}</Text>
        <View style={{ width: 26 }} />
      </View>

      {/* Progress */}
      <View style={styles.progress}>
        {STEPS.map((s, i) => (
          <View key={s} style={{ flex: 1, alignItems: "center" }}>
            <View style={[styles.pill, i <= step && styles.pillActive]} />
            <Text style={[styles.pillLabel, i === step && { color: colors.primary, fontWeight: "700" }]}>{s}</Text>
          </View>
        ))}
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xl + Math.max(insets.bottom, 0) }} keyboardShouldPersistTaps="handled">
          {step === 0 && (
            <>
              <SectionTitle>What should we remind you about?</SectionTitle>
              <Input label="Title" placeholder="e.g. Pay electricity bill" value={title} onChangeText={setTitle} testID="wizard-title" />
              <Input
                label="Custom message (optional)"
                placeholder="Include links, invoice numbers, etc."
                value={message}
                onChangeText={setMessage}
                multiline
                numberOfLines={4}
                style={{ height: 110, textAlignVertical: "top", paddingTop: 14 }}
                testID="wizard-message"
              />
            </>
          )}

          {step === 1 && (
            <>
              <SectionTitle>When should we trigger it?</SectionTitle>
              <View style={{ flexDirection: "row", gap: 10 }}>
                <TouchableOpacity style={[styles.pickBtn]} onPress={() => setShowDate(true)} testID="wizard-pick-date">
                  <Ionicons name="calendar-outline" size={18} color={colors.primary} />
                  <Text style={styles.pickVal}>{date.toDateString()}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.pickBtn]} onPress={() => setShowTime(true)} testID="wizard-pick-time">
                  <Ionicons name="time-outline" size={18} color={colors.primary} />
                  <Text style={styles.pickVal}>
                    {String(time.getHours()).padStart(2, "0")}:{String(time.getMinutes()).padStart(2, "0")}
                  </Text>
                </TouchableOpacity>
              </View>

              <Card style={{ flexDirection: "row", alignItems: "center", backgroundColor: colors.primaryTint, borderColor: "transparent", marginTop: spacing.md }}>
                <Ionicons name="flash" size={18} color={colors.primary} />
                <Text style={{ marginLeft: 8, color: colors.text, flex: 1 }}>
                  First fire at {fmtDate(finalDateTime.toISOString())}
                </Text>
              </Card>

              <View style={styles.repeatSection}>
                <View style={styles.repeatHeader}>
                  <Text style={styles.repeatTitle}>Repeat Reminders</Text>
                  <Switch
                    value={repeatEnabled}
                    onValueChange={setRepeatEnabled}
                    trackColor={{ false: colors.border, true: colors.primary }}
                    thumbColor="#fff"
                    testID="repeat-toggle"
                  />
                </View>

                <View pointerEvents={repeatEnabled ? "auto" : "none"} style={{ opacity: repeatEnabled ? 1 : 0.4 }}>
                  <View style={styles.inlineRow}>
                    <Text style={styles.inlineText}>Repeat</Text>
                    <TextInput
                      style={styles.inlineInput}
                      keyboardType="numeric"
                      placeholder="—"
                      placeholderTextColor={colors.textMuted}
                      value={repeatCount}
                      onChangeText={(t) => setRepeatCount(digitsOnly(t))}
                      maxLength={2}
                      editable={repeatEnabled}
                      testID="wizard-repeat-count"
                    />
                    <Text style={styles.inlineText}>times</Text>
                  </View>
                  <Text style={styles.repeatHint}>Type 0 for unlimited repeats until I stop.</Text>

                  <View style={[styles.inlineRow, { marginTop: spacing.md, flexWrap: "wrap" }]}>
                    <Text style={styles.inlineText}>Repeat reminders after every</Text>
                    <TextInput
                      style={styles.inlineInput}
                      keyboardType="numeric"
                      value={repeatValue}
                      onChangeText={(t) => setRepeatValue(digitsOnly(t))}
                      maxLength={5}
                      editable={repeatEnabled}
                      testID="wizard-repeat-value"
                    />
                    <UnitDropdown value={repeatUnit} onChange={setRepeatUnit} />
                  </View>
                </View>
              </View>
            </>
          )}

          {step === 2 && (
            <>
              <SectionTitle>Pick delivery channels</SectionTitle>
              <View style={{ gap: 10 }}>
                <ChannelTile
                  icon="notifications-outline"
                  title="App Notification"
                  desc="Instant push on this device"
                  cost="Free"
                  selected={channels.includes("push")}
                  onPress={() => toggleChannel("push")}
                  testID="ch-push"
                />
                <ChannelTile
                  icon="logo-whatsapp"
                  title="WhatsApp"
                  desc="Send a WhatsApp message"
                  cost={costLabel(rates?.whatsapp)}
                  locked={isFree}
                  selected={channels.includes("whatsapp")}
                  onPress={() => toggleChannel("whatsapp")}
                  testID="ch-whatsapp"
                />
                <ChannelTile
                  icon="mail-outline"
                  title="Email"
                  desc="Deliver to inbox"
                  cost={costLabel(rates?.email)}
                  locked={isFree}
                  selected={channels.includes("email")}
                  onPress={() => toggleChannel("email")}
                  testID="ch-email"
                />
                <ChannelTile
                  icon="chatbubble-outline"
                  title="SMS"
                  desc="Text message"
                  cost={costLabel(rates?.sms)}
                  locked={isFree}
                  selected={channels.includes("sms")}
                  onPress={() => toggleChannel("sms")}
                  testID="ch-sms"
                />
              </View>
              {billing ? (
                <TouchableOpacity onPress={() => router.push("/plans")} style={styles.creditNote} activeOpacity={0.8}>
                  <Ionicons name={isFree ? "lock-closed-outline" : "wallet-outline"} size={15} color={colors.primary} />
                  <Text style={styles.creditNoteText}>
                    {isFree
                      ? "You're on the Free plan. Buy a credit pack to unlock WhatsApp, SMS and email."
                      : `You have ${formatCredits(billing.credits)} credits. Each message is charged when it's sent.`}
                  </Text>
                </TouchableOpacity>
              ) : null}
            </>
          )}

          {step === 3 && (
            <>
              <SectionTitle>Who is this for?</SectionTitle>
              <View style={{ flexDirection: "row", marginBottom: spacing.md }}>
                <Chip label="Myself" selected={isSelf} onPress={() => { setIsSelf(true); setContactId(null); }} icon="person-outline" testID="target-self" />
                <Chip label="Someone else" selected={!isSelf} onPress={() => setIsSelf(false)} icon="people-outline" testID="target-other" />
              </View>
              {!isSelf && channels.some((c) => c !== "push") ? (
                <Text style={styles.copyNote}>
                  {"You'll get your own copy on WhatsApp, SMS or email, and that copy uses credits. Sending it on to them from your phone is free."}
                </Text>
              ) : null}

              {isSelf && (
                <Card style={{ backgroundColor: colors.primaryTint, borderColor: "transparent", flexDirection: "row", alignItems: "center" }}>
                  <Ionicons name="information-circle" size={24} color={colors.primary} />
                  <Text style={{ marginLeft: 10, color: colors.text, flex: 1, fontSize: 13, lineHeight: 20 }}>
                    The reminder will be sent directly to you through the delivery method you selected (such as notifications, email, etc.).
                  </Text>
                </Card>
              )}

              {!isSelf && (
                <>
                  <OptionCheckbox
                    label="Send to an existing contact"
                    selected={targetMode === "existing"}
                    onPress={chooseExisting}
                    disabled={contacts.length === 0}
                    testID="target-mode-existing"
                  />
                  <OptionCheckbox
                    label="Send to a new person"
                    selected={targetMode === "new"}
                    onPress={chooseNew}
                    testID="target-mode-new"
                  />
                  {contacts.length === 0 && (
                    <Text style={{ color: colors.textMuted, fontSize: 12, marginBottom: spacing.sm }}>
                      No saved contacts yet — choose "Send to a new person".
                    </Text>
                  )}

                  {targetMode === "existing" && contacts.length > 0 && (
                    <View style={{ marginTop: spacing.md }}>
                      <Text style={styles.label}>Pick from contacts</Text>
                      <ContactDropdown
                        contacts={contacts}
                        selectedId={contactId}
                        onSelect={(c) => {
                          setContactId(c.id);
                          setTargetName(c.name);
                          setTargetPhone(c.phone || "");
                          setTargetEmail(c.email || "");
                        }}
                      />
                      {selectedContact && (
                        <Card style={{ marginTop: 4 }}>
                          <ReadOnlyRow label="Name" value={selectedContact.name} />
                          {selectedContact.phone ? <ReadOnlyRow label="Phone" value={selectedContact.phone} /> : null}
                          {selectedContact.email ? <ReadOnlyRow label="Email" value={selectedContact.email} /> : null}
                        </Card>
                      )}
                    </View>
                  )}

                  {targetMode === "new" && (
                    <View style={{ marginTop: spacing.md }}>
                      <Input label="Name" placeholder="Recipient name" value={targetName} onChangeText={setTargetName} testID="target-name" />
                      {recipientNeedsPhone && (
                        <Input
                          label={phoneFieldLabel}
                          placeholder="+91 9876543210"
                          keyboardType="phone-pad"
                          value={targetPhone}
                          onChangeText={setTargetPhone}
                          hint={
                            channels.includes("whatsapp") || channels.includes("sms")
                              ? undefined
                              : "Used to find their app and deliver the notification. If they're not on the app, the reminder comes to you to forward."
                          }
                          testID="target-phone"
                        />
                      )}
                      {channels.includes("email") && (
                        <Input
                          label="Email"
                          placeholder="person@example.com"
                          autoCapitalize="none"
                          keyboardType="email-address"
                          value={targetEmail}
                          onChangeText={setTargetEmail}
                          testID="target-email"
                        />
                      )}
                      <TouchableOpacity
                        style={styles.checkRow}
                        onPress={() => setSavePerson(!savePerson)}
                        testID="save-person-toggle"
                      >
                        <View style={[styles.checkbox, savePerson && { backgroundColor: colors.primary, borderColor: colors.primary }]}>
                          {savePerson && <Ionicons name="checkmark" size={14} color="#fff" />}
                        </View>
                        <Text style={{ color: colors.text }}>Save as a contact</Text>
                      </TouchableOpacity>
                    </View>
                  )}
                </>
              )}
            </>
          )}

          {/* Action sits right under the step content, not pinned to the bottom */}
          <View style={{ marginTop: spacing.lg }}>
            {step < 3 ? (
              <Button label="Continue" onPress={next} testID="wizard-next" />
            ) : (
              <Button label="Create reminder" icon="checkmark-circle" onPress={submit} loading={saving} testID="wizard-submit" />
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Pickers */}
      <PickerSheet visible={showDate} initial={date} mode="date" onClose={() => setShowDate(false)} onConfirm={(d) => setDate(d)} />
      <PickerSheet visible={showTime} initial={time} mode="time" onClose={() => setShowTime(false)} onConfirm={(d) => setTime(d)} />

      {/* Saved success */}
      <Modal transparent animationType="fade" visible={savedSheet}>
        <View style={styles.overlay}>
          <View style={styles.successCard}>
            <View style={styles.successIcon}>
              <Ionicons name="checkmark" size={36} color="#fff" />
            </View>
            <Text style={{ fontSize: 22, fontWeight: "800", color: colors.text, marginBottom: 6 }}>All set!</Text>
            <Text style={{ color: colors.textMuted, textAlign: "center", marginBottom: spacing.lg }}>
              Your reminder has been scheduled.
            </Text>
            <Button
              label="Back to dashboard"
              onPress={() => {
                setSavedSheet(false);
                router.replace("/(app)/dashboard");
                // Positive moment — ask for a store rating if a milestone was hit
                maybeAskForRating();
              }}
              testID="success-dashboard"
            />
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function ChannelTile({
  icon,
  title,
  desc,
  cost,
  locked,
  selected,
  onPress,
  testID,
}: {
  icon: any;
  title: string;
  desc: string;
  cost?: string;
  locked?: boolean;
  selected: boolean;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <TouchableOpacity activeOpacity={0.85} onPress={onPress} testID={testID}>
      <View
        style={{
          borderWidth: 1.5,
          borderColor: selected ? colors.primary : colors.border,
          backgroundColor: selected ? colors.primaryTint : locked ? colors.surfaceAlt : colors.surface,
          borderRadius: radius.lg,
          padding: spacing.md,
          flexDirection: "row",
          alignItems: "center",
        }}
      >
        <View
          style={{
            width: 44,
            height: 44,
            borderRadius: 12,
            backgroundColor: selected ? colors.primary : locked ? colors.secondary : colors.primaryTint,
            alignItems: "center",
            justifyContent: "center",
            marginRight: 12,
          }}
        >
          <Ionicons name={icon} size={20} color={selected ? "#fff" : locked ? colors.textMuted : colors.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontWeight: "700", color: locked ? colors.textMuted : colors.text, fontSize: 16 }}>{title}</Text>
          <Text style={{ color: colors.textMuted, fontSize: 13 }}>{locked ? "Needs credits" : desc}</Text>
          {cost && !locked ? (
            <Text style={{ color: colors.primary, fontSize: 12, fontWeight: "600", marginTop: 2 }}>{cost}</Text>
          ) : null}
        </View>
        {selected ? (
          <Ionicons name="checkmark-circle" size={22} color={colors.primary} />
        ) : locked ? (
          <Ionicons name="lock-closed" size={18} color={colors.textMuted} />
        ) : null}
      </View>
    </TouchableOpacity>
  );
}

function UnitDropdown({ value, onChange }: { value: RepeatUnit; onChange: (u: RepeatUnit) => void }) {
  const [open, setOpen] = useState(false);
  const current = UNIT_OPTIONS.find((o) => o.value === value)!;
  return (
    <>
      <TouchableOpacity style={ddStyles.trigger} activeOpacity={0.85} onPress={() => setOpen(true)} testID="wizard-repeat-unit">
        <Text style={ddStyles.triggerText}>{current.label}</Text>
        <Ionicons name="chevron-down" size={14} color={colors.textMuted} />
      </TouchableOpacity>
      <Modal transparent animationType="fade" visible={open} onRequestClose={() => setOpen(false)}>
        <TouchableOpacity style={ddStyles.overlay} activeOpacity={1} onPress={() => setOpen(false)}>
          <View style={ddStyles.menu}>
            {UNIT_OPTIONS.map((o) => {
              const selected = o.value === value;
              return (
                <TouchableOpacity
                  key={o.value}
                  style={[ddStyles.item, selected && { backgroundColor: colors.primaryTint }]}
                  onPress={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                  testID={`repeat-unit-${o.value}`}
                >
                  <Text style={{ color: selected ? colors.primary : colors.text, fontSize: 15, fontWeight: selected ? "700" : "500" }}>
                    {o.label}
                  </Text>
                  {selected && <Ionicons name="checkmark" size={16} color={colors.primary} />}
                </TouchableOpacity>
              );
            })}
          </View>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

const ddStyles = StyleSheet.create({
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 44,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
  },
  triggerText: { color: colors.text, fontSize: 15, fontWeight: "600" },
  overlay: { flex: 1, backgroundColor: colors.overlay, justifyContent: "center", padding: spacing.lg },
  menu: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    paddingVertical: 6,
    width: "100%",
    maxWidth: 380,
    alignSelf: "center",
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: 13,
  },
});

function ContactDropdown({
  contacts,
  selectedId,
  onSelect,
}: {
  contacts: Contact[];
  selectedId: string | null;
  onSelect: (c: Contact) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = contacts.find((c) => c.id === selectedId);
  return (
    <View style={{ marginBottom: spacing.md }}>
      <TouchableOpacity style={cdStyles.trigger} activeOpacity={0.85} onPress={() => setOpen(true)} testID="contact-dropdown">
        <View style={{ flex: 1 }}>
          {selected ? (
            <>
              <Text style={cdStyles.name}>{selected.name}</Text>
              {selected.phone ? <Text style={cdStyles.phone}>{selected.phone}</Text> : null}
            </>
          ) : (
            <Text style={{ color: colors.textMuted, fontSize: 15 }}>Select a contact</Text>
          )}
        </View>
        <Ionicons name="chevron-down" size={18} color={colors.textMuted} />
      </TouchableOpacity>
      <Modal transparent animationType="fade" visible={open} onRequestClose={() => setOpen(false)}>
        <TouchableOpacity style={cdStyles.overlay} activeOpacity={1} onPress={() => setOpen(false)}>
          <View style={cdStyles.menu}>
            <Text style={cdStyles.menuTitle}>Pick from contacts</Text>
            <ScrollView style={{ maxHeight: 320 }} keyboardShouldPersistTaps="handled">
              {contacts.map((c) => {
                const sel = c.id === selectedId;
                return (
                  <TouchableOpacity
                    key={c.id}
                    style={[cdStyles.row, sel && { backgroundColor: colors.primaryTint }]}
                    onPress={() => {
                      onSelect(c);
                      setOpen(false);
                    }}
                    testID={`pick-contact-${c.id}`}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: colors.text, fontSize: 15, fontWeight: "600" }}>{c.name}</Text>
                      {c.phone ? <Text style={{ color: colors.textMuted, fontSize: 13, marginTop: 2 }}>{c.phone}</Text> : null}
                    </View>
                    {sel && <Ionicons name="checkmark" size={18} color={colors.primary} />}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const cdStyles = StyleSheet.create({
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 52,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  name: { color: colors.text, fontSize: 15, fontWeight: "600" },
  phone: { color: colors.textMuted, fontSize: 13, marginTop: 2 },
  overlay: { flex: 1, backgroundColor: colors.overlay, justifyContent: "center", padding: spacing.lg },
  menu: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    paddingVertical: 6,
    width: "100%",
    maxWidth: 380,
    alignSelf: "center",
  },
  menuTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.textMuted,
    paddingHorizontal: spacing.md,
    paddingTop: 8,
    paddingBottom: 4,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
  },
});

function OptionCheckbox({
  label,
  selected,
  onPress,
  disabled,
  testID,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <TouchableOpacity
      style={[styles.optionRow, selected && styles.optionRowActive, disabled && { opacity: 0.4 }]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.85}
      testID={testID}
    >
      <View style={[styles.checkbox, selected && { backgroundColor: colors.primary, borderColor: colors.primary }]}>
        {selected && <Ionicons name="checkmark" size={14} color="#fff" />}
      </View>
      <Text style={{ color: colors.text, fontWeight: "600", flex: 1 }}>{label}</Text>
    </TouchableOpacity>
  );
}

function ReadOnlyRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ paddingVertical: 6 }}>
      <Text style={{ color: colors.textMuted, fontSize: 12 }}>{label}</Text>
      <Text style={{ color: colors.text, fontSize: 15, fontWeight: "600", marginTop: 2 }}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  creditNote: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginTop: spacing.md,
    paddingHorizontal: 4,
  },
  creditNoteText: { flex: 1, marginLeft: 8, fontSize: 12, lineHeight: 17, color: colors.textMuted },
  copyNote: { fontSize: 12, lineHeight: 17, color: colors.textMuted, marginTop: -4, marginBottom: spacing.md },
  topRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  topTitle: { fontSize: 18, fontWeight: "700", color: colors.text },
  progress: { flexDirection: "row", paddingHorizontal: spacing.lg, marginTop: spacing.md, marginBottom: spacing.md },
  pill: { width: "85%", height: 4, backgroundColor: colors.border, borderRadius: 2, marginBottom: 6 },
  pillActive: { backgroundColor: colors.primary },
  pillLabel: { fontSize: 11, color: colors.textMuted },
  label: { fontSize: 13, fontWeight: "600", color: colors.text, marginBottom: 6 },
  pickBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  pickVal: { color: colors.text, marginLeft: 8, fontWeight: "600" },
  repeatSection: {
    marginTop: spacing.lg,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  repeatHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.md },
  repeatTitle: { fontSize: 15, fontWeight: "700", color: colors.text },
  inlineRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  inlineText: { color: colors.text, fontSize: 15, fontWeight: "500" },
  inlineInput: {
    minWidth: 64,
    height: 44,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    paddingHorizontal: 12,
    fontSize: 16,
    color: colors.text,
    textAlign: "center",
  },
  repeatHint: { fontSize: 12, color: colors.textMuted, marginTop: 6 },
  checkRow: { flexDirection: "row", alignItems: "center", marginTop: 10 },
  optionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    marginBottom: 8,
  },
  optionRowActive: { borderColor: colors.primary, backgroundColor: colors.primaryTint },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: colors.border,
    marginRight: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "center", alignItems: "center", padding: spacing.lg },
  successCard: {
    width: "100%", maxWidth: 380,
    backgroundColor: colors.surface, borderRadius: radius.xl,
    padding: spacing.xl, alignItems: "center",
  },
  successIcon: {
    width: 74, height: 74, borderRadius: 37,
    backgroundColor: colors.primary,
    alignItems: "center", justifyContent: "center",
    marginBottom: spacing.md,
  },
});
