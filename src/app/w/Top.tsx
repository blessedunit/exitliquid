// The /w landing under the search: the Known snipers board. Server component; data from lib/topWallets.
// Unknown is "—", never 0. Farm groups are never shown here.
import Link from "next/link";
import { Portrait } from "@/components/Sprite";
import { fmtInt, shortAddr } from "@/lib/format";
import { knownSnipers } from "@/lib/topWallets";
import { sniperSkinOf } from "./skin";
import t from "./top.module.css";

type Snipers = NonNullable<ReturnType<typeof knownSnipers>>;

const two = (i: number) => String(i).padStart(2, "0");
const addr = (a: string) => shortAddr(a, 6, 4);
const vars = (o: Record<string, string | number>) => o as React.CSSProperties;

function Rank({ n }: { n: number }) {
  return <span className={`${t.rank} ${n <= 3 ? t.top3 : ""}`}>{two(n)}</span>;
}

function Head({ id, title, sub }: { id: string; title: string; sub?: React.ReactNode }) {
  return (
    <header className={t.head}>
      <h2 id={id}>{title}</h2>
      {sub && <span>{sub}</span>}
    </header>
  );
}

/** the next round percent above the leader, and a tick step that gives 4-10 ticks */
function axisOf(leadPct: number) {
  const max = leadPct < 20 ? Math.floor(leadPct) + 1 : Math.ceil((leadPct + 0.01) / 5) * 5;
  const step = max <= 10 ? 1 : max <= 20 ? 2 : max <= 50 ? 5 : 10;
  return { max, step };
}

function SnipersBoard({ set }: { set: Snipers }) {
  const rows = set.top.slice(0, 25);
  const scanned = set.tokensScanned;
  if (!rows.length) return null;
  const share = (e: number) => (scanned ? (e / scanned) * 100 : null);
  const ax = axisOf(share(rows[0].entries) ?? 0);
  const n = Math.floor(ax.max / ax.step);
  const labels = [0, Math.round(n / 2) * ax.step, n * ax.step];
  return (
    <section className={t.block} aria-labelledby="w-snipers">
      <Head
        id="w-snipers"
        title="Known snipers"
        sub={set.minTokens && set.windowDays ? `in the first 20 buyers of ${set.minTokens} launches or more · ${set.windowDays} days` : undefined}
      />
      <div className={`${t.cols} ${t.snipCols}`} aria-hidden>
        <span />
        <span />
        <span>Wallet</span>
        <span className={t.r}>Entries</span>
        <span className={t.axisHead}>
          {labels.map((x) => <em key={x} style={vars({ "--x": x / (n * ax.step) })}>{x}%</em>)}
        </span>
        <span className={t.r}>Share</span>
      </div>
      <ol className={t.board}>
        {rows.map((r, i) => {
          const p = share(r.entries);
          return (
            <li key={r.address}>
              <Link href={`/w/${r.address}`} prefetch={false} className={`${t.row} ${t.snipCols}`}>
                <Rank n={i + 1} />
                <Portrait skin={sniperSkinOf(r.address)} size={28} className={t.face} />
                <span className={t.addr}>{addr(r.address)}</span>
                <span className={`${t.num} ${t.r} ${t.ent}`}>{fmtInt(r.entries)}</span>
                <span className={t.axis} style={vars({ "--n": n })} aria-hidden>
                  <i style={{ width: `${p === null ? 0 : Math.max(0.6, (p / ax.max) * 100)}%` }} />
                </span>
                <span className={`${t.num} ${t.r} ${t.pct}`}>{p === null ? "—" : `${p.toFixed(1)}%`}</span>
              </Link>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function TopTraders() {
  const set = knownSnipers(25);
  // unknown is said in words, never drawn as an empty table
  if (!set) return <p className={t.quiet}>The sniper index is updating.</p>;
  if (!set.top.length) return <p className={t.quiet}>The sniper index is counting entries.</p>;
  return <SnipersBoard set={set} />;
}
