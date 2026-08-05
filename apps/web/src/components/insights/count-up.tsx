import { useMotionValue, useReducedMotion, useSpring, useTransform } from "motion/react";
import { useEffect, useState } from "react";

export function CountUp(props: {
  value: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  className?: string;
}) {
  const reduceMotion = useReducedMotion();
  const decimals = props.decimals ?? 0;
  const mv = useMotionValue(0);
  const spring = useSpring(mv, {
    stiffness: 120,
    damping: 28,
    mass: 0.8,
  });
  const display = useTransform(spring, (latest) => {
    const fixed = Number(latest).toFixed(decimals);
    return `${props.prefix ?? ""}${fixed}${props.suffix ?? ""}`;
  });
  const [text, setText] = useState(
    `${props.prefix ?? ""}${(reduceMotion ? props.value : 0).toFixed(decimals)}${props.suffix ?? ""}`,
  );

  useEffect(() => {
    if (reduceMotion) {
      mv.jump(props.value);
      return;
    }
    mv.set(props.value);
  }, [mv, props.value, reduceMotion]);

  useEffect(() => display.on("change", setText), [display]);

  return (
    <span className={props.className} aria-label={text}>
      {text}
    </span>
  );
}
