"use client";

import { type ReactNode } from "react";
import styles from "./LiquidBankCard.module.css";

export function LiquidBankCard({ children, className, light = false, locked = false }: {
  children: ReactNode; className?: string; light?: boolean; locked?: boolean;
}) {
  return <section className={`${styles.card} ${className ?? ""}`} data-light={light || undefined} data-locked={locked || undefined}>
    <div className={styles.surface} aria-hidden="true"><i /><i /><i className={styles.glow} /></div>
    <div className={styles.content}>{children}</div>
  </section>;
}
