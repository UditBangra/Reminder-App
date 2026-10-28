import React, { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, LayoutChangeEvent, StyleSheet, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";

/**
 * A soft band of light that sweeps across its parent every few seconds. Drop it as
 * the last child of a view with overflow "hidden". Stays still when the OS asks
 * for reduced motion.
 */
export function Shine({
  color = "rgba(255,255,255,0.22)",
  duration = 1400,
  pause = 2600,
}: {
  color?: string;
  duration?: number;
  pause?: number;
}) {
  const progress = useRef(new Animated.Value(0)).current;
  const [width, setWidth] = useState(0);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion).catch(() => {});
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!width || reduceMotion) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(pause),
        Animated.timing(progress, {
          toValue: 1,
          duration,
          easing: Easing.inOut(Easing.cubic),
          useNativeDriver: true,
        }),
      ])
    );
    progress.setValue(0);
    loop.start();
    return () => loop.stop();
  }, [width, reduceMotion, duration, pause, progress]);

  const band = Math.max(80, width * 0.35);
  const translateX = progress.interpolate({ inputRange: [0, 1], outputRange: [-band * 1.6, width + band * 0.6] });

  return (
    <View
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
    >
      {width > 0 && !reduceMotion ? (
        <Animated.View
          style={{
            position: "absolute",
            top: "-50%",
            bottom: "-50%",
            width: band,
            transform: [{ translateX }, { rotate: "18deg" }],
          }}
        >
          <LinearGradient
            colors={["rgba(255,255,255,0)", color, "rgba(255,255,255,0)"]}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            style={{ flex: 1 }}
          />
        </Animated.View>
      ) : null}
    </View>
  );
}
