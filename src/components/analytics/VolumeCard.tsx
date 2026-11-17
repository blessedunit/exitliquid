"use client";
// "Real volume": volume with wash (dust trades under 0.0001 ETH, one wallet in and out within the wash window, 5 minutes) and
// known-bot trades (Early Index sniper / farm wallets) taken out. Each ETH sits in one bucket only: a bot's dust
// trade is wash, not bots too, so Real + Bots + Wash = the whole volume and the headline matches the bar.
// Open to everyone: the windows table and who makes the volume.
import { fmtEth, fmtInt, shortAddr } from "@/lib/format";
import type { VolWindow } from "@/lib/analytics/types";
import type { AnalyticsState } from "./useTokenAnalytics";
import { Addr, Card, Pending, pct, Source, Tag } from "./bits";
import s from "./analytics.module.css";

/** the round-trip window as words: the answer's own window (seconds), 5 minutes when an older answer lacks it */
const washWindow = (sec: number | undefined) => {
  const v = sec ?? 300;
  return v % 60 === 0 ? `${v / 60} minute${v === 60 ? "" : "s"}` : `${v} seconds`;
};

const share = (part: number | null, all: number) => (part === null ? null : all > 0 ? (part / all) * 100 : 0);
const LABEL: Record<VolWindow["label"], string> = { "1h": "1h", "24h": "24h", all: "All" };

export default function VolumeCard({ state, onSelect }: { state: AnalyticsState; onSelect?: (w: string) => void }) {
  const f = state.a?.volume;
  // every "Eth" amount of the answer is in the pair's unit: ETH, or the pair token on a v6 launch (NVDA, USDG...)
  const U = state.a?.unit?.symbol ?? "ETH";
  const d = f?.data;
  const day = d?.windows.find((w) => w.label === "24h") ?? d?.windows.find((w) => w.label === "all") ?? null;
  const washPct = day ? share(day.washEth, day.volumeEth) : null;
  const botPct = day ? share(day.botEth, day.volumeEth) : null;
  const realPct = day ? share(day.realEth, day.volumeEth) : null;
  // the 1h column is the first to go when the card is narrow (it is also in the summary's B / S 1h)
  const hide = (w: VolWindow) => (w.label === "1h" && d && d.windows.length > 2 ? s.narrowHide : undefined);
  return (
    <Card
      id="an-volume"
      title="Real volume"
      term="real-volume"
      sub={d ? (d.venue === "pool" ? "V4 pool" : d.venue === "both" ? "curve + V4 pool" : "curve") : "wash and bots out"}
      src={f && d ? f : null}
      stale={state.stale}
      loading={!d && state.trouble === "loading"}
    >
      {!d || !f || !day ? (
        <Pending state={state} reason={f?.reason} reading="Reading trades…" />
      ) : (
        <>
          <div className={s.hero}>
            <p className={s.big}>
              <b>{fmtEth(day.realEth)} {U}</b>
              <span>real volume · {LABEL[day.label]}</span>
            </p>
            <p className={s.line2}>
              of <b>{fmtEth(day.volumeEth)} {U}</b> total · wash <b>{pct(washPct)}</b> · bots <b>{botPct === null ? "—" : pct(botPct)}</b>
            </p>
          </div>
          {day.volumeEth > 0 && (
            <>
              <div className={s.split} role="img" aria-label={`Real ${pct(realPct)}, bots ${botPct === null ? "unknown" : pct(botPct)}, wash ${pct(washPct)}`}>
                <i className={s.s_real} style={{ width: `${realPct ?? 0}%` }} />
                {botPct !== null && <i className={s.s_bot} style={{ width: `${botPct}%` }} />}
                <i className={s.s_wash} style={{ width: `${washPct ?? 0}%` }} />
              </div>
              <div className={s.splitKey} aria-hidden>
                <span style={{ ["--k" as string]: "var(--exit)" }}>Real {pct(realPct)}</span>
                <span style={{ ["--k" as string]: "var(--t3)" }}>Bots {botPct === null ? "—" : pct(botPct)}</span>
                <span style={{ ["--k" as string]: "var(--down)" }}>Wash {pct(washPct)}</span>
              </div>
            </>
          )}
          <div className={s.tblWrap}>
            <table className={s.tbl}>
              <caption className="srOnly">Volume by window, {U}</caption>
              <thead>
                <tr><th scope="col"><span className="srOnly">Measure</span></th>{d.windows.map((w) => <th key={w.label} scope="col" className={hide(w)}>{LABEL[w.label]}</th>)}</tr>
              </thead>
              <tbody>
                <Row name="Volume" ws={d.windows} hide={hide} v={(w) => `${fmtEth(w.volumeEth)}`} />
                <Row name="Real" ws={d.windows} hide={hide} v={(w) => `${fmtEth(w.realEth)}`} cls={s.up} hint="Volume without wash and without known-bot trades" />
                <Row name="Wash" ws={d.windows} hide={hide} v={(w) => (w.washEth ? fmtEth(w.washEth) : "0")} hint={`${d.dust == null ? "In-and-out" : `Dust trades under ${d.dust} ${U} plus in-and-out`} by one wallet within ${washWindow(d.washWindowSec)}`} />
                <Row name="Buys / sells" ws={d.windows} hide={hide} v={(w) => `${fmtInt(w.buys)} / ${fmtInt(w.sells)}`} />
                <Row name="Buyers" ws={d.windows} hide={hide} v={(w) => fmtInt(w.buyers)} />
                <Row name="Buys per buyer" ws={d.windows} hide={hide} v={(w) => (w.buysPerBuyer === null ? "—" : w.buysPerBuyer.toFixed(2))} hint="Many buys per wallet = a few wallets making the activity" />
                <Row name="Bot share" ws={d.windows} hide={hide} v={(w) => (w.botEth === null ? "—" : pct(share(w.botEth, w.volumeEth)))} hint="Volume of known sniper / farm wallets (Early Index), wash left out" />
                {d.windows.some((w) => w.unknownTrades > 0) && (
                  <Row name="Size unknown" ws={d.windows} hide={hide} v={(w) => fmtInt(w.unknownTrades)} hint="Pool trades whose ETH size couldn't be read: left out of the sums, not counted as zero" cls={s.dim} />
                )}
              </tbody>
            </table>
          </div>
          {d.topTraders.length > 0 && (
            <>
              <h4 className={s.subHead}>Who makes the volume <span className={s.subMeta}>{d.topTradersWindow === "all" ? "all time" : "24h"}</span></h4>
              <ol className={s.list}>
                {d.topTraders.slice(0, 6).map((t, i) => (
                  <li key={t.wallet} className={s.row}>
                    <span className={s.rank}>{i + 1}</span>
                    <span className={s.who}>
                      <Addr wallet={t.wallet} onSelect={onSelect}>{shortAddr(t.wallet)}</Addr>
                      {t.tag && <Tag tone={t.tag === "sniper" ? "bad" : "warn"}>{t.tag === "sniper" ? "Sniper" : t.tag === "farm" ? "Farm" : t.tag}</Tag>}
                    </span>
                    <span className={s.right}>{fmtEth(t.eth)} {U} <span className={s.rank}>{pct(t.sharePct)} · {t.trades}×</span></span>
                  </li>
                ))}
              </ol>
            </>
          )}
          <Source reason={f.reason} />
        </>
      )}
    </Card>
  );
}

function Row({ name, ws, v, cls, hint, hide }: { name: string; ws: VolWindow[]; v: (w: VolWindow) => string; cls?: string; hint?: string; hide: (w: VolWindow) => string | undefined }) {
  return (
    <tr title={hint}>
      <td className={s.rowHead}>{name}</td>
      {ws.map((w) => <td key={w.label} className={[cls, hide(w)].filter(Boolean).join(" ") || undefined}>{v(w)}</td>)}
    </tr>
  );
}
