"use client";
// "Same ticker": other vibe/vibe launches that use this ticker (moved out of Supply into the Dev section).
// Only the first one is the original; a later copy is context, not a verdict. Data: the analytics clones field.
// The server reads every match (up to the newest 200) and sends a short list: the earliest 5, the biggest 5 and
// this token. So `earliest` is the real first unless `partial`; places past the earliest 5 are not known here.
import Link from "next/link";
import { useState } from "react";
import { fmtInt, shortAddr } from "@/lib/format";
import type { AnalyticsState } from "./useTokenAnalytics";
import { Card, Pending, Source, Tag } from "./bits";
import s from "./analytics.module.css";

const SHOWN = 8;
const EARLIEST_SENT = 5; // clones.ts: the earliest 5 are always in the list, in order
const day = (sec: number) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(sec * 1000);

export default function SameTicker({ state }: { state: AnalyticsState }) {
  const [all, setAll] = useState(false);
  const f = state.a?.clones;
  const c = f?.data;
  const items = c ? [...c.items].sort((a, b) => a.createdAt - b.createdAt) : [];
  const total = c ? c.matches + 1 : 0;
  const myIndex = items.findIndex((x) => x.self);
  // a short list: places are known for the earliest 5 (always sent, in order); past them only when nothing was left out
  const complete = items.length >= total;
  const placeOf = (i: number) => (complete || i < EARLIEST_SENT ? i + 1 : null);
  const myPlace = myIndex >= 0 ? placeOf(myIndex) : null;
  // the first launch is only claimed when the whole ticker history was read (not cut at the newest 200)
  const firstKnown = !!c?.earliest && !c.partial;
  const short = items.slice(0, SHOWN);
  // the page's own token stays in view when the list is clamped
  if (myIndex >= SHOWN) short.push(items[myIndex]);
  const rows = all ? items : short;
  const canExpand = items.length > short.length;
  return (
    <Card id="an-clones" title="Same ticker" term="ticker-clone" sub={c ? `$${c.symbol}` : "other launches"} src={f && c ? f : null} stale={state.stale} loading={!c && state.trouble === "loading"}>
      {!c || !f ? (
        <Pending state={state} reason={f?.reason} reading="Reading launches with this ticker…" />
      ) : c.matches === 0 ? (
        <p className={s.noneLine}>No other launch uses ${c.symbol}{c.partial ? " in the newest 200 matches" : ""}.</p>
      ) : (
        <>
          <div className={s.hero}>
            <p className={s.line2}>
              Ticker used by <b>{fmtInt(total)}</b> launches
              {myPlace !== null && <> · this is <b>#{myPlace}</b></>}
              {c.earliest && <> · {firstKnown ? "first" : "earliest read"}: <b>{shortAddr(c.earliest.token)}</b>, {day(c.earliest.createdAt)}</>}
              {c.partial ? " (newest 200 read: an older one may exist)" : ""}
            </p>
            {!complete && <p className={s.line2}>Showing {fmtInt(items.length)} of {fmtInt(total)}: the earliest and the biggest.</p>}
          </div>
          <ol className={s.list}>
            {rows.map((x) => {
              const place = placeOf(items.indexOf(x));
              return (
              <li key={x.token} className={s.row}>
                <span className={s.rank} title={place === null ? "Place unknown: launches between the earliest and this one are not listed" : undefined}>{place ?? "—"}</span>
                <span className={s.who}>
                  {x.self ? <span>{shortAddr(x.token)}</span> : <Link className={s.addr} href={`/line/${x.token}`} prefetch={false}>{shortAddr(x.token)}</Link>}
                  {x.self && <Tag tone="ok">This one</Tag>}
                  {firstKnown && c.earliest?.token === x.token && <Tag>First</Tag>}
                  {x.graduated && <Tag>Graduated</Tag>}
                </span>
                <span className={s.right}>{day(x.createdAt)} <span className={s.rank}>{x.holders === null ? "—" : `${fmtInt(x.holders)} holders`}</span></span>
              </li>
              );
            })}
          </ol>
          {canExpand && (
            <button type="button" className={s.more} onClick={() => setAll((v) => !v)} aria-expanded={all}>
              {all ? "Show less" : `Show all ${fmtInt(items.length)} launches`}
            </button>
          )}
          <Source reason={f.reason} />
        </>
      )}
    </Card>
  );
}
