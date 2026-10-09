// Linked wallets: who first funded the dev, who else that funder funded, and who the dev funded.
// Faucets and hubs are named and never clustered. A shared funder is a reason to look closer, never proof.
import Link from "next/link";
import { devLinks, type DevLinks, type LinkedWallet } from "@/lib/devrep";
import { EXPLORER } from "@/lib/config";
import { fmtEth, shortAddr } from "@/lib/format";
import Tags from "./Tags";
import styles from "./dev.module.css";

export function LinkedSkeleton() {
  return (
    <div className={styles.card} aria-busy="true">
      <div className={styles.cardHead}><h2>Linked wallets</h2><span className={styles.cardSub} role="status">Reading the explorer…</span></div>
      {Array.from({ length: 4 }, (_, i) => <span key={i} className={styles.skel} />)}
    </div>
  );
}

function Addr({ w }: { w: LinkedWallet }) {
  // a wallet that launched tokens gets its own passport; any other its wallet profile
  return (
    <span>
      {w.launches !== null && w.launches > 0 ? (
        <Link className={styles.addrLink} href={`/dev/${w.address}`} prefetch={false}>{shortAddr(w.address)}</Link>
      ) : (
        <Link className={styles.addrLink} href={`/w/${w.address}`} prefetch={false} title="Wallet profile">{shortAddr(w.address)}</Link>
      )}
      <a className={styles.ext} href={`${EXPLORER}/address/${w.address}`} target="_blank" rel="noreferrer" aria-label={`${w.address} on the explorer`}>↗</a>
    </span>
  );
}

function Facts({ w }: { w: LinkedWallet }) {
  return (
    <span className={styles.lFacts}>
      <span title={w.launchesChecked ? (w.launches === null ? "vibe did not answer" : undefined) : "Not checked (we check the first few only)"}>
        Launched <b className={w.launches ? styles.hot : undefined}>{w.launches === null ? "—" : w.launches}</b>
      </span>
      <span title={w.boughtDevLaunches === null ? "Unknown: the chain read failed" : "Of this dev's launches, how many this wallet received tokens of"}>
        Got this dev&apos;s tokens <b className={w.boughtDevLaunches ? styles.hot : undefined}>{w.boughtDevLaunches === null ? "—" : w.boughtDevLaunches}</b>
      </span>
    </span>
  );
}

function List({ items }: { items: (LinkedWallet & { eth?: number; txs?: number })[] }) {
  return (
    <ul className={styles.lList}>
      {items.map((w) => (
        <li key={w.address} className={styles.lRow}>
          <Addr w={w} />
          <span className={styles.lTags}>
            <Tags tags={w.tags} />
            {w.eth !== undefined && <span className={styles.tag}>{fmtEth(w.eth)} ETH · {w.txs} tx</span>}
          </span>
          <Facts w={w} />
        </li>
      ))}
    </ul>
  );
}

function fundingLine(l: DevLinks) {
  const f = l.funding;
  if (!f) return "Unknown: the explorer did not answer. Retried on the next visit.";
  if (f.kind === "faucet") return "The public faucet, which funds most testnet wallets: no link to anyone.";
  if (f.kind === "bridge") return "Bridged its own ETH from L1: no on-chain funder to follow.";
  if (f.kind === "none") return "No incoming ETH in its first transactions: source unknown.";
  return null;
}

export default async function Linked({ addr }: { addr: string }) {
  let l: DevLinks;
  try {
    l = await devLinks(addr);
  } catch {
    return (
      <div className={styles.card}>
        <div className={styles.cardHead}><h2>Linked wallets</h2></div>
        <p className={styles.msg}>The explorer did not answer, so linked wallets are unknown right now (not none).</p>
      </div>
    );
  }

  const fund = l.funder;
  const linked = [...(fund && fund.hub !== true ? [fund] : []), ...l.siblings, ...l.funded, ...l.senders];
  const buyers = linked.filter((w) => (w.boughtDevLaunches ?? 0) > 0);
  const launchers = l.siblings.filter((w) => (w.launches ?? 0) > 0);
  const fl = fundingLine(l);
  const unk = new Set(l.unknown);
  // all three lists read and empty: one line instead of three "none" blocks
  const empty = !unk.has("siblings") && !unk.has("funded") && l.siblings.length === 0 && l.senders.length === 0 && l.funded.length === 0;

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <h2>Linked wallets</h2>
        <span className={styles.cardSub}>by first funder · Blockscout</span>
      </div>

      {buyers.length > 0 && (
        <p className={styles.alert}>
          {buyers.length} linked wallet{buyers.length === 1 ? "" : "s"} got tokens of this dev&apos;s launches.
        </p>
      )}

      <div className={styles.lSec}>
        <p className={styles.lHead}>First funded by</p>
        <div className={styles.funder}>
          {fl ? (
            <span>{fl}</span>
          ) : fund ? (
            <>
              <span className={styles.funderLine}>
                <Addr w={fund} />
                <Tags tags={fund.tags} />
                {fund.hub === true && <span className={`${styles.tag} ${styles.tQuiet}`}>Hub</span>}
                {fund.hub !== true && fund.launchesChecked && (
                  <span className={styles.lFacts}>Launched <b className={fund.launches ? styles.hot : undefined}>{fund.launches === null ? "—" : fund.launches}</b></span>
                )}
              </span>
              {fund.hub === true && <span>A busy wallet (faucet, exchange or bot hub) that funded a crowd: not read as a cluster.</span>}
              {fund.hub === null && <span>Could not check whether this funder is a hub: treat the list below with care.</span>}
            </>
          ) : null}
        </div>
      </div>

      {empty ? (
        <div className={styles.lSec}><p className={styles.msg}>No linked wallets found in the first 200 transactions.</p></div>
      ) : (<>
      {fund && fund.hub !== true && (
        <div className={styles.lSec}>
          <p className={styles.lHead}>
            Also funded by the same wallet
            <span>
              {unk.has("siblings") ? "unknown" : `${l.siblingsSeen}${l.siblingsCut ? " in first 200 tx" : ""}${launchers.length ? ` · ${launchers.length} launched` : ""}`}
            </span>
          </p>
          {unk.has("siblings") ? (
            <p className={styles.msg}>The explorer did not answer: unknown, not none.</p>
          ) : l.siblings.length ? (
            <List items={l.siblings} />
          ) : (
            <p className={styles.msg}>No other wallets in the funder&apos;s first 200 transactions.</p>
          )}
        </div>
      )}

      <div className={styles.lSec}>
        <p className={styles.lHead}>
          Sent ETH to this dev
          <span>{unk.has("funded") ? "unknown" : `${l.sendersSeen}${l.fundedCut ? " in first 200 tx" : ""}${l.sendersHubs ? ` · ${l.sendersHubs} hub${l.sendersHubs === 1 ? "" : "s"} left out` : ""}`}</span>
        </p>
        {unk.has("funded") ? (
          <p className={styles.msg}>The explorer did not answer: unknown, not none.</p>
        ) : l.senders.length ? (
          <List items={l.senders} />
        ) : (
          <p className={styles.msg}>No plain ETH from other wallets in the dev&apos;s first 200 transactions{l.funding?.kind === "faucet" ? " (faucet only)" : ""}.</p>
        )}
      </div>

      <div className={styles.lSec}>
        <p className={styles.lHead}>
          Funded by this dev
          <span>{unk.has("funded") ? "unknown" : `${l.fundedSeen}${l.fundedCut ? " in first 200 tx" : ""}`}</span>
        </p>
        {unk.has("funded") ? (
          <p className={styles.msg}>The explorer did not answer: unknown, not none.</p>
        ) : l.funded.length ? (
          <List items={l.funded} />
        ) : (
          <p className={styles.msg}>The dev sent no plain ETH to other wallets in its first 200 transactions.</p>
        )}
      </div>
      </>)}

      <p className={styles.note}>
        Plain ETH transfers only, from the first 200 transactions, up to 40 per list. &quot;Launched&quot; is checked for the funder, the top senders and the first few wallets.
        Early Index labels mark known snipers and farms. A shared funder is a reason to look closer, never proof.
      </p>
    </div>
  );
}
