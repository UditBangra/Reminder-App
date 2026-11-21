import React from "react";
import {
  View,
  Text,
  TextInput,
  TextInputProps,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ViewStyle,
  TextStyle,
} from "react-native";
import { colors, radius, shadow, spacing } from "./theme";
import { Ionicons } from "@expo/vector-icons";

/* ---------- Button ---------- */
type BtnProps = {
  label: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  loading?: boolean;
  disabled?: boolean;
  icon?: keyof typeof Ionicons.glyphMap;
  style?: ViewStyle;
  testID?: string;
};
export function Button({
  label,
  onPress,
  variant = "primary",
  loading,
  disabled,
  icon,
  style,
  testID,
}: BtnProps) {
  const bg =
    variant === "primary"
      ? colors.primary
      : variant === "secondary"
      ? colors.secondary
      : variant === "danger"
      ? colors.danger
      : "transparent";
  const fg =
    variant === "secondary"
      ? colors.text
      : variant === "ghost"
      ? colors.primary
      : colors.textInverse;
  return (
    <TouchableOpacity
      testID={testID}
      activeOpacity={0.85}
      onPress={onPress}
      disabled={disabled || loading}
      style={[
        {
          backgroundColor: bg,
          opacity: disabled ? 0.55 : 1,
          height: 54,
          borderRadius: radius.pill,
          paddingHorizontal: 20,
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "row",
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <>
          {icon ? (
            <Ionicons name={icon} size={18} color={fg} style={{ marginRight: 8 }} />
          ) : null}
          <Text
            numberOfLines={1}
            ellipsizeMode="tail"
            style={{
              color: fg,
              fontSize: 16,
              fontWeight: "600",
              paddingHorizontal: icon ? 4 : 16,
              flexShrink: 1,
            }}
          >
            {label}
          </Text>
        </>
      )}
    </TouchableOpacity>
  );
}

/* ---------- Input ---------- */
type InpProps = TextInputProps & { label?: string; hint?: string; error?: string; testID?: string };
export function Input({ label, hint, error, style, testID, ...rest }: InpProps) {
  // Italicise only while empty so the example text reads as a placeholder,
  // not as real input. Typed text stays upright.
  const isEmpty = !rest.value;
  return (
    <View style={{ marginBottom: spacing.md }}>
      {label ? <Text style={inpStyles.label}>{label}</Text> : null}
      <TextInput
        testID={testID}
        placeholderTextColor={colors.placeholder}
        style={[inpStyles.input, isEmpty ? { fontStyle: "italic", fontSize: 15 } : null, error ? { borderColor: colors.danger } : null, style]}
        {...rest}
      />
      {hint ? <Text style={inpStyles.hint}>{hint}</Text> : null}
      {error ? <Text style={{ color: colors.danger, marginTop: 6, fontSize: 12 }}>{error}</Text> : null}
    </View>
  );
}
const inpStyles = StyleSheet.create({
  label: {
    fontSize: 13,
    fontWeight: "600",
    color: colors.text,
    marginBottom: 6,
    letterSpacing: 0.2,
  },
  hint: {
    fontSize: 11,
    color: colors.textMuted,
    marginTop: 6,
    lineHeight: 15,
  },
  input: {
    height: 52,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 16,
    backgroundColor: colors.surface,
    fontSize: 16,
    color: colors.text,
  },
});

/* ---------- Card ---------- */
export function Card({
  children,
  style,
  onPress,
  testID,
}: {
  children: React.ReactNode;
  style?: ViewStyle;
  onPress?: () => void;
  testID?: string;
}) {
  const content = (
    <View style={[cardStyle.card, style]} testID={testID}>
      {children}
    </View>
  );
  if (!onPress) return content;
  return (
    <TouchableOpacity activeOpacity={0.85} onPress={onPress} testID={testID}>
      <View style={[cardStyle.card, style]}>{children}</View>
    </TouchableOpacity>
  );
}
const cardStyle = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow.card,
  },
});

/* ---------- Chip ---------- */
export function Chip({
  label,
  selected,
  onPress,
  icon,
  testID,
}: {
  label: string;
  selected?: boolean;
  onPress: () => void;
  icon?: keyof typeof Ionicons.glyphMap;
  testID?: string;
}) {
  return (
    <TouchableOpacity
      testID={testID}
      onPress={onPress}
      activeOpacity={0.85}
      style={{
        flexDirection: "row",
        alignItems: "center",
        backgroundColor: selected ? colors.primary : colors.surface,
        borderColor: selected ? colors.primary : colors.border,
        borderWidth: 1,
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: radius.pill,
        marginRight: 8,
        marginBottom: 8,
      }}
    >
      {icon ? (
        <Ionicons
          name={icon}
          size={14}
          color={selected ? colors.textInverse : colors.textMuted}
          style={{ marginRight: 6 }}
        />
      ) : null}
      <Text
        style={{
          color: selected ? colors.textInverse : colors.textMuted,
          fontSize: 13,
          fontWeight: "600",
        }}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

/* ---------- SectionTitle ---------- */
export function SectionTitle({ children, style }: { children: React.ReactNode; style?: TextStyle }) {
  return (
    <Text
      style={[
        {
          fontSize: 11,
          fontWeight: "700",
          color: colors.textMuted,
          letterSpacing: 2,
          textTransform: "uppercase",
          marginBottom: 10,
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

/* ---------- Badge ---------- */
export function Badge({
  label,
  color,
}: {
  label: string;
  color?: string;
}) {
  const bg = color || colors.primaryTint;
  const fg = color ? "#fff" : colors.primary;
  return (
    <View
      style={{
        backgroundColor: bg,
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: radius.pill,
      }}
    >
      <Text style={{ color: fg, fontSize: 11, fontWeight: "700", letterSpacing: 0.3 }}>
        {label}
      </Text>
    </View>
  );
}

/* ---------- PromiseBanner ---------- */
// The brand promise shown on sign-in / sign-up, so new users see up front that
// Rymind is free to start.
export function PromiseBanner({ style }: { style?: ViewStyle }) {
  return (
    <View
      style={[
        {
          backgroundColor: colors.primaryTint,
          borderRadius: radius.lg,
          paddingVertical: 14,
          paddingHorizontal: spacing.md,
          marginTop: spacing.lg,
        },
        style,
      ]}
    >
      <Text style={{ fontSize: 16, fontWeight: "800", color: colors.primary, letterSpacing: -0.2 }}>
        One Reminder, Every Channel.
      </Text>
      {["Free signup, no credit card required", "Free forever for individuals with limited needs"].map((t) => (
        <View key={t} style={{ flexDirection: "row", alignItems: "flex-start", marginTop: 6 }}>
          <Ionicons name="checkmark-circle" size={16} color={colors.primary} style={{ marginTop: 1 }} />
          <Text style={{ flex: 1, marginLeft: 8, fontSize: 13, lineHeight: 18, color: colors.text }}>{t}</Text>
        </View>
      ))}
    </View>
  );
}
