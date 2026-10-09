// Instant shell of a dev passport: shows the moment a dev link is clicked, before the server answers.
// Same boxes as the page (crumb row, H1, PassportSkeleton, LinkedSkeleton), so nothing jumps when it lands.
import { PassportSkeleton } from "./Passport";
import { LinkedSkeleton } from "./Linked";
import styles from "./dev.module.css";

export default function DevLoading() {
  return (
    <section className={styles.page} aria-busy="true" aria-label="Loading the dev passport">
      <div className={`wrap ${styles.inner}`}>
        <div className={styles.crumbRow}>
          <nav className={styles.crumb} aria-hidden>
            <span>Devs</span>
            <span>/</span>
            <span className={styles.crumbAddr}>…</span>
          </nav>
        </div>
        <header className={styles.head}>
          <h1 className={styles.h1}>Dev passport</h1>
        </header>
        <PassportSkeleton />
        <LinkedSkeleton />
      </div>
    </section>
  );
}
