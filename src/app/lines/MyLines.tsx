"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { connectWallet, getPrivyAddress, PRIVY_ENABLED } from "@/lib/wallet";
import EmptyState from "@/components/ui/EmptyState";
import LookupField from "../w/LookupField";
import { useWatchlist } from "../launches/watch";
import type { LaunchCard } from "@/lib/launches";
import w from "../w/w.module.css";
import { IS_LIVE, PUBLIC_SITE_URL, VIBE_APP, X_HANDLE, X_LIVE, EXPLORER } from "@/lib/config";
import type { TicketResponse } from "@/lib/types";
import styles from "./lines.module.css";
import { fmtCompact, fmtEth as fmtEthShared, pct } from "@/lib/format";

type Holding = {
  token: string;
  name: string;
  symbol: string;
  tokens: number;
  valueEth: number | null;
  progressBps: number | null;
  graduated: boolean | null; // null = unknown right now
  isExit: boolean;
};
type Scan = {
  wallet: string;
  eth: number | null;
  stocks: { symbol: string; balance: string }[] | null;
  holdings: Holding[];
  scanned: number;
  truncated: boolean;
  unknownTokens?: number;
};
type Place = {
  status: "in_line" | "exited" | "never" | "unknown" | "busy";
  place?: number;
  inLine: number;
  ahead?: number;
  behind?: number;
  exitedAhead?: number;
  exitSignalPct?: number;
  lp?: number;
  rank?: string;
};

const FAUCET = "https://faucet.testnet.chain.robinhood.com";
const DISCONNECTED_KEY = "exit.wallet.disconnected";
const MAX_ROWS = 100; // lines read per wallet (the rest are listed without a place)
const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a.trim());

const fmtTokens = fmtCompact;
const fmtEth = (n: number | null) => (n !== null && n > 0 && n < 0.001 ? "<0.001" : fmtEthShared(n));

function signalClass(p?: number) {
  if (p === undefined) return "";
  return p >= 60 ? styles.hot : p >= 30 ? styles.warm : styles.cool;
}

export default function MyLines() {
  const router = useRouter();
  const params = useSearchParams();
  const [addr, setAddr] = useState(params.get("w") ?? "");
  const [wallet, setWallet] = useState<string | null>(null);
  const [connectedWallet, setConnectedWallet] = useState<string | null>(null);
  const [scan, setScan] = useState<Scan | null>(null);
  const [places, setPlaces] = useState<Record<string, Place | "loading">>({});
  const [exitTicket, setExitTicket] = useState<TicketResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sort, setSort] = useState<"value" | "signal">("value");
  const run = useRef(0);
  // a wallet in the URL (?w=) wins over the connected one; otherwise the page follows the connected wallet
  const urlWallet = useRef<string | null>(null);
  const follow = useRef<boolean | null>(null);
  const [followTick, setFollowTick] = useState(0);
  if (follow.current === null) {
    const w = params.get("w");
    urlWallet.current = w && isAddr(w) ? w.trim().toLowerCase() : null;
    follow.current = !urlWallet.current;
  }

  useEffect(() => {
    const provider = (window as typeof window & { ethereum?: {
      request: (a: { method: string }) => Promise<unknown>;
      on?: (event: string, fn: (accounts: string[]) => void) => void;
      removeListener?: (event: string, fn: (accounts: string[]) => void) => void;
    } }).ethereum;
    let active = true;
    if (PRIVY_ENABLED) {
      // Privy decides who is connected; follow its address, never the extension's own account
      const onPrivy = (e: Event) => {
        const a = (e as CustomEvent<string | null>).detail;
        let off = false;
        try { off = localStorage.getItem(DISCONNECTED_KEY) === "1"; } catch { /* storage can be blocked */ }
        const next = !off && a && isAddr(a) ? a.toLowerCase() : null;
        setConnectedWallet(next);
        if (next) setAddr((current) => current || next);
      };
      window.addEventListener("exit-privy-wallet", onPrivy);
      const known = getPrivyAddress();
      if (known) onPrivy(new CustomEvent("exit-privy-wallet", { detail: known }));
      return () => {
        active = false;
        window.removeEventListener("exit-privy-wallet", onPrivy);
      };
    }
    const changed = (accounts: string[]) => {
      if (!active) return;
      try { if (localStorage.getItem(DISCONNECTED_KEY) === "1") { setConnectedWallet(null); return; } } catch { /* storage can be blocked */ }
      const next = accounts.find(isAddr)?.toLowerCase() ?? null;
      setConnectedWallet(next);
      if (next) setAddr((current) => current || next);
    };
    const sync = () => {
      try { if (localStorage.getItem(DISCONNECTED_KEY) === "1") { setConnectedWallet(null); return; } } catch { /* storage can be blocked */ }
      void provider?.request({ method: "eth_accounts" }).then((accounts: unknown) => changed(Array.isArray(accounts) ? accounts : []), () => {});
    };
    provider?.on?.("accountsChanged", changed);
    window.addEventListener("exit-wallet-change", sync);
    sync();
    return () => {
      active = false;
      provider?.removeListener?.("accountsChanged", changed);
      window.removeEventListener("exit-wallet-change", sync);
    };
  }, []);

  const load = useCallback(
    async (w: string) => {
      const id = ++run.current;
      setErr(null);
      setBusy(true);
      setScan(null);
      setPlaces({});
      setExitTicket(null);
      setWallet(w);
      router.replace(`/lines?w=${w}`, { scroll: false });
      try {
        const [r, t] = await Promise.all([
          fetch(`/api/wallet/${w}`),
          IS_LIVE ? fetch(`/api/ticket/${w}`).then((x) => (x.ok ? (x.json() as Promise<TicketResponse>) : null), () => null) : null,
        ]);
        if (id !== run.current) return;
        if (r.status === 429) throw new Error("Too many lookups. Try again in a minute.");
        if (!r.ok) throw new Error("The chain isn't answering. Try again in a minute.");
        const s = (await r.json()) as Scan;
        setScan(s);
        setExitTicket(t);
        setBusy(false);
        // places: three at a time (a token seen for the first time loads its whole history)
        const queue = s.holdings.slice(0, MAX_ROWS);
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const worker = async () => {
          for (let h = queue.shift(); h; h = queue.shift()) {
            if (id !== run.current) return;
            setPlaces((p) => ({ ...p, [h!.token]: "loading" }));
            let v: Place = { status: "unknown", inLine: 0 };
            // the server says "busy" when many lines load at once: wait and ask again
            for (let attempt = 0; attempt < 6; attempt++) {
              try {
                const x = await fetch(`/api/line/${h.token}?wallet=${w}`);
                if (x.ok) v = (await x.json()) as Place;
                else if (x.status === 429) v = { status: "busy", inLine: 0 };
              } catch {
                v = { status: "unknown", inLine: 0 };
              }
              if (v.status !== "busy" || id !== run.current) break;
              await sleep(3_000 + attempt * 2_000);
            }
            if (id !== run.current) return;
            setPlaces((p) => ({ ...p, [h!.token]: v.status === "busy" ? { status: "unknown", inLine: 0 } : v }));
          }
        };
        await Promise.all([worker(), worker(), worker()]);
      } catch (e) {
        if (id === run.current) setErr((e as Error).message);
      } finally {
        if (id === run.current) setBusy(false);
      }
    },
    [router],
  );

  // a shared /lines?w=0x… link opens straight into that wallet (once, on arrival)
  const opened = useRef(false);
  useEffect(() => {
    const w = urlWallet.current;
    if (opened.current || !w) return;
    // mark it inside the timer: a dev StrictMode remount clears the first timer and must be able to schedule again
    const t = setTimeout(() => {
      opened.current = true;
      void load(w);
    }, 0);
    return () => clearTimeout(t);
  }, [load]);

  // connected wallet: show its lines at once, follow connect / switch / disconnect
  useEffect(() => {
    // the URL wallet is the connected one: from now on follow the connection
    if (connectedWallet && connectedWallet === urlWallet.current) follow.current = true;
    if (!follow.current) return;
    const t = setTimeout(() => {
      if (connectedWallet) {
        if (connectedWallet === wallet) return;
        setAddr(connectedWallet);
        void load(connectedWallet);
      } else if (wallet) {
        // disconnected: clear the wallet we were showing for it
        run.current++;
        setScan(null);
        setPlaces({});
        setExitTicket(null);
        setWallet(null);
        setBusy(false);
        setErr(null);
        setAddr("");
        router.replace("/lines", { scroll: false });
      }
    }, 0);
    return () => clearTimeout(t);
    // `wallet` is read, not followed: a manual lookup must not re-trigger this
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectedWallet, followTick, load, router]);

  // a fresh Connect anywhere on the site (header included) switches the page back to the connected wallet
  useEffect(() => {
    const onChange = () => {
      try { if (localStorage.getItem(DISCONNECTED_KEY) === "1") return; } catch { /* storage can be blocked */ }
      follow.current = true;
      setFollowTick((n) => n + 1);
    };
    window.addEventListener("exit-wallet-change", onChange);
    return () => window.removeEventListener("exit-wallet-change", onChange);
  }, []);

  const submit = (a: string) => {
    if (!isAddr(a)) {
      setErr("Not a wallet address (0x + 40 hex characters).");
      return;
    }
    const w = a.trim().toLowerCase();
    // a different address typed by hand: stop following the connected wallet until it is looked up again
    follow.current = w === connectedWallet;
    // "you are here" on the $EXIT corridor: only a wallet the visitor typed or connected, never a shared ?w= link
    try {
      localStorage.setItem("exit.me", w);
      window.dispatchEvent(new Event("exit-me-change"));
    } catch {
      /* storage blocked: the marker just doesn't show */
    }
    void load(w);
  };
  const connect = async () => {
    setErr(null);
    try {
      const a = await connectWallet();
      try { localStorage.removeItem(DISCONNECTED_KEY); } catch { /* storage can be blocked */ }
      setConnectedWallet(a);
      window.dispatchEvent(new Event("exit-wallet-change"));
      setAddr(a);
      submit(a);
      follow.current = true;
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  // your $EXIT rank follows you into every line
  const exitEntry = exitTicket?.status === "in_line" ? exitTicket.entry : undefined;
  const myRank = exitEntry ? (exitTicket?.tierName ?? "In line") : null;

  const rows = useMemo(() => {
    const hs = [...(scan?.holdings ?? [])];
    if (sort === "signal") {
      const sig = (h: Holding) => {
        const p = places[h.token];
        return p && p !== "loading" && p.exitSignalPct !== undefined ? p.exitSignalPct : -1;
      };
      hs.sort((a, b) => Number(b.isExit) - Number(a.isExit) || sig(b) - sig(a));
    }
    return hs;
  }, [scan, places, sort]);

  const totalEth = scan?.holdings.reduce((s, h) => s + (h.valueEth ?? 0), 0) ?? 0;
  const pins = useWatchlist();

  return (
    <div className={styles.root}>
      <LookupField
        id="lines-addr"
        label="Wallet address"
        placeholder="Paste a 0x wallet address"
        cta="Show lines"
        busyCta="Reading…"
        busy={busy && !scan}
        value={addr}
        onChange={(v) => {
          setAddr(v);
          setErr(null);
        }}
        onSubmit={submit}
        error={err}
        after={!connectedWallet ? <ConnectLine onConnect={connect} disabled={busy} /> : null}
      />
      {!scan && !busy && !err && !pins.length && <EmptyLines />}

      {scan && wallet && (
        <>
          <section className={styles.block} aria-labelledby="lines-wallet">
            <div className={styles.blockHead}>
              <h2 id="lines-wallet" className={styles.blockTitle}>
                Wallet <span className={styles.addrMono}>{wallet.slice(0, 6)}…{wallet.slice(-4)}</span>
              </h2>
              <span className={styles.headLinks}>
                <Link className={styles.ghost} href={`/w/${wallet.toLowerCase()}`} prefetch={false}>Wallet profile →</Link>
                <a className={styles.ghost} href={`${EXPLORER}/address/${wallet}`} target="_blank" rel="noopener noreferrer">Explorer ↗</a>
              </span>
            </div>
            <dl className={styles.stats}>
              <div>
                <dt>ETH</dt>
                <dd className={scan.eth === null ? styles.unk : undefined} title={scan.eth === null ? "Unknown, not zero." : undefined}>{fmtEth(scan.eth)}</dd>
              </div>
              <div>
                <dt>vibe tokens</dt>
                <dd>{scan.holdings.length}</dd>
              </div>
              <div>
                <dt>Bags ≈ ETH</dt>
                <dd>{fmtEth(totalEth)}</dd>
              </div>
              <div>
                <dt>Stocks</dt>
                <dd className={styles.stockList}>
                  {scan.stocks === null ? (
                    <span className={styles.unk} title="Unknown, not zero.">—</span>
                  ) : scan.stocks.length ? (
                    scan.stocks.map((s) => (
                      <span key={s.symbol}>
                        {s.symbol} {(Number(BigInt(s.balance) / 10n ** 12n) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 })}
                      </span>
                    ))
                  ) : (
                    <span className={styles.unk}>none</span>
                  )}
                </dd>
              </div>
            </dl>
            <p className={styles.meta}>
              {IS_LIVE ? (
                exitEntry ? (
                  <>$EXIT rank: <b>{myRank}</b> · #{exitEntry.place} in the $EXIT line, {exitEntry.behind.toLocaleString("en-US")} behind. <Link href={`/t/${wallet}`} prefetch={false}>Ticket →</Link></>
                ) : (
                  <>Not in the $EXIT line.</>
                )
              ) : (
                <>$EXIT isn&apos;t live yet.</>
              )}
              {" "}Test ETH and stocks: <a href={FAUCET} target="_blank" rel="noopener noreferrer">faucet ↗</a>
            </p>
          </section>

          <section className={styles.block} aria-labelledby="lines-title">
          <div className={styles.blockHead}>
            <h2 id="lines-title" className={styles.blockTitle}>Your lines</h2>
            <div className={styles.sort} role="group" aria-label="Sort">
              <button type="button" aria-pressed={sort === "value"} onClick={() => setSort("value")}>
                By bag
              </button>
              <button type="button" aria-pressed={sort === "signal"} onClick={() => setSort("signal")}>
                By exits ahead
              </button>
            </div>
          </div>

          {rows.length === 0 ? (
            <EmptyState
              boxed={false}
              skin="ghost"
              title="No vibe/vibe tokens here"
              action={<a className="btn" href={VIBE_APP} target="_blank" rel="noopener noreferrer">Browse vibe/vibe ↗</a>}
            >
              This wallet holds no vibe/vibe tokens right now.
            </EmptyState>
          ) : (
            <>
            <div className={styles.cols} aria-hidden="true">
              <span>Token</span>
              <span className={styles.rcol}>Bag</span>
              <span>Your place</span>
              <span />
            </div>
            <ol className={styles.list}>
              {rows.map((h, i) => {
                const p = places[h.token];
                const ready = p && p !== "loading" ? p : null;
                const skipped = i >= MAX_ROWS;
                const share = ready?.status === "in_line" ? shareHref(h.symbol, ready, wallet, h.isExit) : null;
                return (
                  <li key={h.token} className={`${styles.row} ${h.isExit ? styles.exitRow : ""}`}>
                    <div className={styles.tok}>
                      <span className={styles.tokTop}>
                        <Link href={`/line/${h.token}`} prefetch={false} className={styles.sym}>
                          ${h.symbol}
                        </Link>
                        <span className={styles.name}>{h.name}</span>
                      </span>
                      <span className={styles.curve}>
                        {h.graduated ? (
                          <span className={styles.gradWord}>Graduated</span>
                        ) : h.progressBps === null ? (
                          <span className={styles.small} title="Unknown, not zero.">curve unknown</span>
                        ) : (
                          <>
                            <span className={styles.bar} title="Bonding curve progress"><i style={{ width: `${h.progressBps / 100}%` }} /></span>
                            <span className={styles.small}>{(h.progressBps / 100).toFixed(1)}%</span>
                          </>
                        )}
                      </span>
                    </div>
                    <div className={styles.bag}>
                      <b>{fmtTokens(h.tokens)}</b>
                      <span className={styles.small}>{h.valueEth === null ? (h.graduated ? "priced in the pool" : "—") : `≈ ${fmtEth(h.valueEth)} ETH`}</span>
                    </div>
                    <div className={styles.place}>
                      {skipped ? (
                        <span className={styles.small}>too many tokens: places shown for the top {MAX_ROWS}</span>
                      ) : !p || p === "loading" ? (
                        <span className={styles.skel} role="status" aria-label="Reading the line" />
                      ) : ready!.status === "in_line" ? (
                        <>
                          <span className={styles.placeTop}>
                            <b>#{ready!.place!.toLocaleString("en-US")}</b>
                            <span className={styles.small}>of {ready!.inLine.toLocaleString("en-US")}</span>
                          </span>
                          {ready!.exitSignalPct === undefined ? (
                            <span className={styles.signal}>nobody was ahead of you</span>
                          ) : !ready!.exitedAhead ? (
                            <span className={styles.signal}>nobody ahead of you has left yet</span>
                          ) : (
                            <span className={`${styles.signal} ${signalClass(ready!.exitSignalPct)}`}>
                              {ready!.exitedAhead} of {(ready!.ahead ?? 0) + ready!.exitedAhead} ahead of you already left
                            </span>
                          )}
                        </>
                      ) : ready!.status === "exited" ? (
                        <span className={styles.small}>walked out</span>
                      ) : ready!.status === "never" ? (
                        <span className={styles.small}>bag too small for a place</span>
                      ) : (
                        <span className={styles.small} title="Unknown, not zero.">line unknown right now</span>
                      )}
                    </div>
                    <div className={styles.act}>
                      {share && (
                        <a className={styles.ghost} href={share} target="_blank" rel="noopener noreferrer">
                          Share
                        </a>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
            </>
          )}
          {(scan.truncated || !!scan.unknownTokens) && (
            <p className={styles.note}>
              {scan.truncated && "Checked the newest 200 tokens this wallet received. "}
              {!!scan.unknownTokens &&
                `${scan.unknownTokens} ${scan.unknownTokens === 1 ? "token" : "tokens"} couldn't be read. Refresh in a minute.`}
            </p>
          )}
          <p className={styles.note}>
            &quot;Already left&quot; = people ahead of you who sold 95%+ since you got in. Values at curve spot price, before fees. Signals, not verdicts.
          </p>
          </section>
        </>
      )}
      {pins.length > 0 && <Pinned pins={pins} />}
    </div>
  );
}

/* ---------------- shared pieces ---------------- */

const TOKEN_RE = /^0x[0-9a-f]{40}$/;

function ConnectLine({ onConnect, disabled = false }: { onConnect?: () => void; disabled?: boolean }) {
  return (
    <p className={w.try}>
      <span>or</span>
      <button type="button" className={styles.quiet} onClick={onConnect} disabled={disabled || !onConnect}>
        Connect a wallet
      </button>
      <span className={styles.quietNote}>read-only, no transactions</span>
    </p>
  );
}

/** no wallet yet: the shared empty state (one sprite, one line, one action) */
function EmptyLines() {
  return (
    <EmptyState
      skin="ghost"
      title="No lines yet"
      action={<Link className="btn" href="/?tab=watch" prefetch={false}>Star tokens on the board →</Link>}
    >
      Paste a wallet to see its place in every line it holds, or star tokens on the board.
    </EmptyState>
  );
}

/** server render (the Suspense fallback): the form and the empty frame, sized like the hydrated page */
export function MyLinesShell() {
  return (
    <div className={styles.root}>
      <LookupField
        id="lines-addr-ssr"
        label="Wallet address"
        placeholder="Paste a 0x wallet address"
        cta="Show lines"
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        after={<ConnectLine />}
      />
      <EmptyLines />
    </div>
  );
}

/** tokens starred on the board (localStorage "exit.watch"), read in batches of 20 like the board's Watchlist */
function Pinned({ pins }: { pins: string[] }) {
  const key = pins.filter((t) => TOKEN_RE.test(t)).join(",");
  const [st, setSt] = useState<{ key: string; cards: Record<string, LaunchCard> | null; failed: boolean }>({ key: "", cards: null, failed: false });
  useEffect(() => {
    if (!key) return;
    let live = true;
    const all = key.split(",");
    const chunks: string[][] = [];
    for (let i = 0; i < all.length; i += 20) chunks.push(all.slice(i, i + 20));
    void Promise.allSettled(
      chunks.map((c) =>
        fetch(`/api/launches?tokens=${c.join(",")}`).then((r) => (r.ok ? (r.json() as Promise<{ items?: LaunchCard[] }>) : Promise.reject(new Error(String(r.status))))),
      ),
    ).then((got) => {
      if (!live) return;
      const cards: Record<string, LaunchCard> = {};
      for (const g of got) if (g.status === "fulfilled") for (const c of g.value.items ?? []) cards[c.token.toLowerCase()] = c;
      setSt({ key, cards, failed: got.every((g) => g.status === "rejected") });
    });
    return () => {
      live = false;
    };
  }, [key]);
  const cards = st.key === key ? st.cards : null;
  const failed = st.key === key && st.failed;
  const list = key ? key.split(",") : [];
  return (
    <section className={styles.block} aria-labelledby="pinned-title">
      <div className={styles.blockHead}>
        <h2 id="pinned-title" className={styles.blockTitle}>Pinned tokens <span className={styles.count}>{list.length}</span></h2>
        <Link className={styles.ghost} href="/?tab=watch" prefetch={false}>Open the watchlist →</Link>
      </div>
      {failed && <p className={styles.empty}>The launch list isn&apos;t answering. Your pins are unknown right now, not gone.</p>}
      <ol className={styles.list}>
        {list.map((t) => {
          const c = cards?.[t];
          return (
            <li key={t} className={styles.pinRow}>
              <div className={styles.tok}>
                <Link href={`/line/${t}`} prefetch={false} className={styles.sym}>
                  {c ? `$${c.symbol || t.slice(0, 8)}` : `${t.slice(0, 6)}…${t.slice(-4)}`}
                </Link>
                <span className={styles.name}>{c ? c.name : cards && !failed ? "not found right now" : failed ? "unknown right now" : "reading…"}</span>
              </div>
              <div className={styles.pinCurve}>
                {c ? (
                  c.graduated ? (
                    <span className={styles.gradWord}>Graduated</span>
                  ) : (
                    <>
                      <span className={styles.bar} title="bonding curve progress"><i style={{ width: `${c.progressBps / 100}%` }} /></span>
                      <span className={styles.small}>to grad {pct(c.progressBps / 100)}</span>
                    </>
                  )
                ) : (
                  cards ? <span className={styles.small} title="Unknown, not zero.">—</span> : <span className={styles.skel} />
                )}
              </div>
              <div className={styles.bag}>
                <b title={c?.holders == null ? "Unknown, not zero." : undefined}>{c?.holders == null ? "—" : fmtTokens(c.holders)}</b>
                <span className={styles.small}>holders</span>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function shareHref(symbol: string, p: Place, wallet: string, isExit: boolean): string {
  const left = p.exitedAhead ? `${p.exitedAhead} of ${(p.ahead ?? 0) + p.exitedAhead} ahead of me already left.` : "nobody ahead of me has left yet.";
  const text = `I'm #${p.place} in the $${symbol} line. ${left}\nwho's your exit liquidity?`;
  // the $EXIT line has its own boarding pass card; any other line shares this wallet's My Lines view
  const url = isExit ? `${PUBLIC_SITE_URL}/t/${wallet}?v=p${p.place}` : `${PUBLIC_SITE_URL}/lines?w=${wallet}`;
  return `https://x.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}${X_LIVE ? `&via=${X_HANDLE}` : ""}`;
}
