import Sprite from "./Sprite";
import WalletAddress from "./WalletAddress";
import TicketLivePnl from "./TicketLivePnl";
import styles from "./TicketCard.module.css";
import type { TicketResponse } from "@/lib/types";
import { formatTokens } from "@/lib/queue";

function Barcode({ seed }: { seed: string }) {
  const hex = seed.replace(/^0x/, "").padEnd(40, "0");
  const bars: { x: number; w: number }[] = [];
  let x = 0;
  for (let i = 0; i < hex.length; i++) {
    const v = parseInt(hex[i], 16);
    const w = 1 + (v % 3);
    if (v % 2 === 0) bars.push({ x, w });
    x += w + 1;
  }
  return (
    <svg viewBox={`0 0 ${x} 30`} preserveAspectRatio="none" className={styles.barcode} aria-hidden>
      {bars.map((b, i) => (
        <rect key={i} x={b.x} y="0" width={b.w} height="30" fill="currentColor" />
      ))}
    </svg>
  );
}

export default function TicketCard({ t }: { t: TicketResponse }) {
  const e = t.entry;
  const exited = t.status === "exited";
  const never = t.status === "never";
  const unknown = t.status === "unknown";
  const people = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "person" : "people"}`;
  const skin = e?.isCreator ? "doorghost" : e?.skin ?? (exited ? "ghost" : "plain");
  const stock = t.stockBacked && t.stockBacked.length > 0;
  return (
    <div id="boarding-pass" className={`${styles.ticket} ${exited ? styles.exited : ""} ${never ? styles.never : ""}`}>
      <div className={styles.main}>
        <div className={styles.top}>
          <span className={styles.brand}>
            <span className={styles.brandLong}>EXIT LIQUIDITY · </span>BOARDING PASS
          </span>
          <span className={styles.mode}>$EXIT</span>
        </div>
        <div className={styles.fields}>
          <div className={styles.field}>
            <span>Passenger</span>
            <WalletAddress wallet={t.wallet} />
          </div>
          <div className={styles.field}>
            <span>Gate</span>
            <b>EXIT</b>
          </div>
          <div className={styles.field}>
            <span>Group</span>
            <b>{e ? t.group : exited ? "Hall of Exits" : unknown ? "?" : "—"}</b>
          </div>
          <div className={styles.field}>
            <span>Rank</span>
            <b>{e ? t.tierName : exited ? "Exited" : unknown ? "?" : "—"}</b>
          </div>
        </div>
        <div className={styles.placeRow}>
          <div>
            <span className={styles.lbl}>{exited ? "Exited at place" : "Place in line"}</span>
            <div className={styles.place}>
              {e ? `#${e.place}` : exited ? `#${t.exit!.exitedAtPlace}` : unknown ? "?" : "—"}
              {e && <span className={styles.of}>/ {t.inLine.toLocaleString("en-US")}</span>}
            </div>
          </div>
          <div className={styles.big2}>
            {e && (
              <>
                <span className={styles.lbl}>Exit liquidity for</span>
                <div className={styles.num}>{e.ahead.toLocaleString("en-US")}</div>
                <span className={styles.lbl}>{e.ahead === 1 ? "person" : "people"} ahead · {people(e.behind)} behind</span>
              </>
            )}
            {exited && (
              <>
                <span className={styles.lbl}>Moved up when it left</span>
                <div className={styles.num}>{t.exit!.behindAtExit.toLocaleString("en-US")}</div>
                <span className={styles.lbl}>thanks for the liquidity</span>
              </>
            )}
          </div>
        </div>
        <div className={styles.fields}>
          <div className={styles.field}>
            <span>Points</span>
            <b>{e ? e.lp.toLocaleString("en-US") : exited ? `0 · gave ${t.exit!.lpReleased}` : unknown ? "?" : "0"}</b>
          </div>
          {!exited && (
            <div className={styles.field}>
              <span>Bag</span>
              <b>{e ? formatTokens(BigInt(e.balance)) : unknown ? "?" : "0"}</b>
            </div>
          )}
          <div className={styles.field}>
            <span>Stock pockets</span>
            <b>{t.stockBacked === null ? "unknown" : stock ? t.stockBacked!.map((s) => s.symbol).join(" ") : "empty"}</b>
          </div>
        </div>
        {e?.isCreator && (
          <div className={styles.pledge}>
            THE DEV · PLEDGED NEVER TO SELL · {BigInt(e.balance) / 10n ** 18n >= BigInt(Math.floor(e.entryTokens)) ? "SOLD: 0" : "CHECK THE CHAIN"}
          </div>
        )}
        {e && <TicketLivePnl t={t} />}
        {never && <div className={styles.stampNever}>NOT IN LINE YET</div>}
        {unknown && <div className={styles.stampNever}>UNKNOWN</div>}
        {exited && <div className={styles.stamp}>EXITED</div>}
      </div>
      <div className={styles.stub}>
        <div className={styles.stubArt}>
<Sprite skin={skin} scale={e?.isCreator ? 1.25 : 2} face="right" />
        </div>
        <div className={styles.stubPlace}>{e ? `#${e.place}` : exited ? "OUT" : unknown ? "?" : "—"}</div>
        {stock && <span className={styles.stock}>STOCK POCKETS</span>}
        <Barcode seed={t.wallet} />
      </div>
    </div>
  );
}
