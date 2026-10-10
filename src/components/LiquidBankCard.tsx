"use client";

import { useEffect, useRef, type PointerEvent, type ReactNode } from "react";
import styles from "./LiquidBankCard.module.css";

// An original CSS/React treatment inspired by JungUI's liquid-gradient demo.
// Decoration never moves the card's financial information or action targets.
export function LiquidBankCard({ children, className, light = false, locked = false }: {
  children: ReactNode; className?: string; light?: boolean; locked?: boolean;
}) {
  const root = useRef<HTMLElement>(null);
  const reducedMotion = useRef(true);

  useEffect(() => {
    const node = root.current;
    if (!node) return;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    let visible = false;
    const update = () => {
      reducedMotion.current = preference.matches;
      node.dataset.animate = String(visible && !document.hidden && !preference.matches);
    };
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; update(); });
    observer.observe(node);
    preference.addEventListener("change", update);
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      observer.disconnect();
      preference.removeEventListener("change", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  const move = (event: PointerEvent<HTMLElement>) => {
    if (reducedMotion.current || event.pointerType !== "mouse") return;
    const rect = event.currentTarget.getBoundingClientRect();
    event.currentTarget.style.setProperty("--light-x", `${(event.clientX - rect.left) / rect.width * 100}%`);
    event.currentTarget.style.setProperty("--light-y", `${(event.clientY - rect.top) / rect.height * 100}%`);
  };

  return <section ref={root} className={`${styles.card} ${className ?? ""}`} data-light={light || undefined} data-locked={locked || undefined}
    onPointerMove={move} onPointerLeave={(event) => {
      event.currentTarget.style.removeProperty("--light-x");
      event.currentTarget.style.removeProperty("--light-y");
    }}>
    <div className={styles.surface} aria-hidden="true"><i /><i /><i className={styles.glow} /></div>
    <div className={styles.content}>{children}</div>
  </section>;
}
