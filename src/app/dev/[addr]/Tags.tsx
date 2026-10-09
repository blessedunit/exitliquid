// Early Index labels for one wallet. No label = nothing shown (not "clean": the index only knows what it scanned).
import styles from "./dev.module.css";

export type TagSet = { sniper: boolean; farm: number | null; verified: boolean };

export default function Tags({ tags }: { tags: TagSet }) {
  if (!tags.sniper && tags.farm === null && !tags.verified) return null;
  return (
    <>
      {tags.sniper && <span className={`${styles.tag} ${styles.tSniper}`} title="Early Index: among the first buyers on 50+ tokens in a week">Sniper</span>}
      {tags.farm !== null && <span className={`${styles.tag} ${styles.tFarm}`} title="Early Index: a group of wallets funded from one source and buying together">Farm #{tags.farm}</span>}
      {tags.verified && <span className={`${styles.tag} ${styles.tVerified}`} title="Early Index: verified early buyer">Verified early</span>}
    </>
  );
}
