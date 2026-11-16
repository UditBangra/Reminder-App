import React, { useEffect, useRef, useState } from "react";
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  NativeScrollEvent,
  NativeSyntheticEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, radius, spacing } from "./theme";
import { Button } from "./ui";

type Props = {
  visible: boolean;
  initial?: Date;
  mode: "date" | "time";
  onClose: () => void;
  onConfirm: (d: Date) => void;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ITEM_H = 40;
const WHEEL_H = 200;
const WHEEL_PAD = (WHEEL_H - ITEM_H) / 2;

const daysInMonth = (year: number, month: number) => new Date(year, month + 1, 0).getDate();

/**
 * Cross-platform date & time picker built from scroll wheels. Each wheel opens
 * scrolled to the current value, and the centered row is the selection, so what
 * the user sees always matches what will be saved.
 */
export function PickerSheet({ visible, initial, mode, onClose, onConfirm }: Props) {
  const [d, setD] = useState<Date>(initial || new Date());
  const insets = useSafeAreaInsets();

  // Start from the caller's current value every time the sheet opens, so a
  // cancelled edit (or a value changed elsewhere) never shows stale numbers.
  useEffect(() => {
    if (visible) setD(initial ? new Date(initial) : new Date());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const year = d.getFullYear();
  const month = d.getMonth();
  const dim = daysInMonth(year, month);
  const days = Array.from({ length: dim }, (_, i) => String(i + 1));
  const curYear = new Date().getFullYear();
  const firstYear = Math.min(curYear, year);
  const years = Array.from({ length: curYear + 6 - firstYear }, (_, i) => String(firstYear + i));
  const hours = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
  const mins = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0"));

  // Rebuild the date in one go and clamp the day, so 31 Jan -> Feb gives 28/29 Feb
  // instead of rolling over into March.
  const set = (patch: Partial<{ day: number; month: number; year: number; hour: number; minute: number }>) => {
    setD((prev) => {
      const y = patch.year ?? prev.getFullYear();
      const m = patch.month ?? prev.getMonth();
      const day = Math.min(patch.day ?? prev.getDate(), daysInMonth(y, m));
      const h = patch.hour ?? prev.getHours();
      const min = patch.minute ?? prev.getMinutes();
      return new Date(y, m, day, h, min, 0, 0);
    });
  };

  return (
    <Modal transparent animationType="slide" visible={visible} onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={[styles.sheet, { paddingBottom: spacing.lg + Math.max(insets.bottom, 0) }]}>
          <View style={styles.handle} />
          <View style={styles.headerRow}>
            <TouchableOpacity onPress={onClose} testID="picker-cancel">
              <Text style={{ color: colors.textMuted, fontSize: 15 }}>Cancel</Text>
            </TouchableOpacity>
            <Text style={styles.title}>{mode === "date" ? "Pick date" : "Pick time"}</Text>
            <View style={{ width: 50 }} />
          </View>

          <View style={styles.row}>
            <View pointerEvents="none" style={styles.selectionBand} />
            {mode === "date" ? (
              <>
                <Wheel label="Day" items={days} value={String(d.getDate())} onChange={(v) => set({ day: Number(v) })} />
                <Wheel label="Month" items={MONTHS} value={MONTHS[month]} onChange={(v) => set({ month: MONTHS.indexOf(v) })} />
                <Wheel label="Year" items={years} value={String(year)} onChange={(v) => set({ year: Number(v) })} />
              </>
            ) : (
              <>
                <Wheel label="Hour" items={hours} value={hours[d.getHours()]} onChange={(v) => set({ hour: Number(v) })} />
                <Wheel label="Min" items={mins} value={mins[d.getMinutes()]} onChange={(v) => set({ minute: Number(v) })} />
              </>
            )}
          </View>

          <Button
            label="Confirm"
            onPress={() => {
              onConfirm(d);
              onClose();
            }}
            testID="picker-confirm"
            style={{ marginTop: spacing.md }}
          />
        </View>
      </View>
    </Modal>
  );
}

function Wheel({
  label,
  items,
  value,
  onChange,
}: {
  label: string;
  items: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  const ref = useRef<ScrollView>(null);
  const index = Math.max(0, items.indexOf(value));
  const laidOut = useRef(false);

  // Keep the selected row centered: on first layout jump straight to it, and
  // follow later changes (a tap, or a day clamped after a month change).
  useEffect(() => {
    if (!laidOut.current) return;
    ref.current?.scrollTo({ y: index * ITEM_H, animated: true });
  }, [index]);

  const pickFromOffset = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const i = Math.round(e.nativeEvent.contentOffset.y / ITEM_H);
    const clamped = Math.min(items.length - 1, Math.max(0, i));
    if (items[clamped] !== value) onChange(items[clamped]);
  };

  return (
    <View style={{ flex: 1, alignItems: "center" }}>
      <Text style={styles.wheelLabel} allowFontScaling={false}>{label}</Text>
      <ScrollView
        ref={ref}
        showsVerticalScrollIndicator={false}
        style={{ height: WHEEL_H, width: "100%" }}
        contentContainerStyle={{ paddingVertical: WHEEL_PAD }}
        snapToInterval={ITEM_H}
        decelerationRate="fast"
        nestedScrollEnabled
        onLayout={() => {
          ref.current?.scrollTo({ y: index * ITEM_H, animated: false });
          laidOut.current = true;
        }}
        onMomentumScrollEnd={pickFromOffset}
        onScrollEndDrag={(e) => {
          // A slow release has no momentum phase on some devices.
          const v = e.nativeEvent.velocity?.y ?? 0;
          if (Math.abs(v) < 0.05) pickFromOffset(e);
        }}
      >
        {items.map((it) => {
          const selected = it === value;
          return (
            <TouchableOpacity key={it} onPress={() => onChange(it)} style={styles.item}>
              <Text
                allowFontScaling={false}
                style={{
                  color: selected ? colors.primary : colors.textMuted,
                  fontSize: selected ? 22 : 16,
                  fontWeight: selected ? "700" : "500",
                }}
              >
                {it}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    padding: spacing.lg,
  },
  handle: {
    alignSelf: "center",
    width: 44,
    height: 5,
    backgroundColor: colors.border,
    borderRadius: 3,
    marginBottom: spacing.md,
  },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: spacing.md },
  title: { fontSize: 17, fontWeight: "700", color: colors.text },
  row: { flexDirection: "row", backgroundColor: colors.background, borderRadius: radius.lg, padding: 10 },
  wheelLabel: { color: colors.textMuted, fontSize: 12, marginBottom: 8, fontWeight: "600", height: 16 },
  item: { height: ITEM_H, alignItems: "center", justifyContent: "center" },
  // Sits behind the centered row of every wheel: label (16) + gap (8) + top padding.
  selectionBand: {
    position: "absolute",
    left: 10,
    right: 10,
    top: 10 + 16 + 8 + WHEEL_PAD,
    height: ITEM_H,
    borderRadius: radius.md,
    backgroundColor: colors.primaryTint,
  },
});
