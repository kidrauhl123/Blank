import type { ReactNode } from "react";
import { TouchPointer } from "./TouchPointer";
import styles from "./PhoneShell.module.css";

// Every product route renders inside one phone-sized surface. There is no
// desktop layout: the mouse pointer is treated as a finger on this screen.
// TouchPointer replaces the system cursor with a round touch point inside it.
export function PhoneShell({ children }: { children: ReactNode }) {
  return <div className={styles.desk}><div className={styles.device} data-phone-shell data-pointer="canvas">{children}<TouchPointer /></div></div>;
}
