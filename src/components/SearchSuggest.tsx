"use client";
// Site search with a typeahead: up to 6 tokens under the box (↑ ↓ Enter Esc), "All results" last.
// A full 0x address opens that token's line (v6 launches included), or the wallet profile / dev passport
// when it is a wallet; a partial 0x… is matched against the lists everyone is browsing. Data: /api/search.
// Free text + Enter filters the board on home (/?q=). Every row carries a type tag: TOKEN / WALLET / DEV.
// size="lg": the 52px paste field (56 on phones) with a visible "Check →" button (home hero, 404, sheet).
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import TokenAvatar from "./TokenAvatar";
import styles from "./SearchSuggest.module.css";

type Sug = { token: string; symbol: string; name: string; image: string | null; progressBps: number; graduated: boolean; v6: boolean };
type Res = { items: Sug[]; more: boolean; kind: "text" | "prefix" | "address"; wallet?: boolean | null };
type Status = "idle" | "loading" | "ok" | "error" | "limited";
type Opt = { id: string; kind: "line" | "vibe" | "all" | "addr" | "wallet" | "dev"; token?: string; sug?: Sug };
export type SearchSuggestProps = {
  className?: string;
  hotkey?: boolean;
  size?: "md" | "lg";
  placeholder?: string;
  autoFocus?: boolean;
  id?: string;
};

const FULL = /^0x[0-9a-fA-F]{40}$/;
const PART = /^0x[0-9a-fA-F]{4,39}$/;
const DEBOUNCE_MS = 250;
const VIBE_TOKEN = (t: string) => `https://testnet.vibevibe.fun/token/${t}`;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** what is worth asking the server about (null = nothing yet) */
function searchable(raw: string): string | null {
  const t = raw.trim();
  const bare = t.replace(/^\$/, "");
  if (/^0x/i.test(bare)) return FULL.test(bare) || PART.test(bare) ? bare.toLowerCase() : null;
  return bare.length >= 2 ? t.slice(0, 64) : null;
}

export default function SearchSuggest({ className, hotkey = false, size = "md", placeholder = "Token, wallet or $ticker", autoFocus = false, id }: SearchSuggestProps) {
  const router = useRouter();
  const uid = useId();
  const listId = `${uid}-list`;
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [res, setRes] = useState<{ key: string; status: Status; data: Res | null }>({ key: "", status: "idle", data: null });
  const input = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);

  const key = searchable(q);

  // "/" focuses the box (only one instance binds it)
  useEffect(() => {
    if (!hotkey) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const el = input.current;
      if (!el || el.offsetParent === null) return; // hidden on this width
      e.preventDefault();
      el.focus();
      el.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hotkey]);

  // debounced lookup; a newer keystroke cancels the older request
  useEffect(() => {
    if (!key || !open) return;
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      setRes((r) => (r.key === key && r.status === "ok" ? r : { key, status: "loading", data: r.data }));
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(key)}`, { signal: ctl.signal });
        if (r.status === 429) return setRes({ key, status: "limited", data: null });
        if (!r.ok) throw new Error(String(r.status));
        const data = (await r.json()) as Res;
        setRes({ key, status: "ok", data });
      } catch {
        if (!ctl.signal.aborted) setRes({ key, status: "error", data: null });
      }
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [key, open]);

  const fresh = res.key === key;
  const data = fresh && res.status === "ok" ? res.data : null;
  const status: Status = !key ? "idle" : fresh ? res.status : "loading";

  // options: tokens first, then the way out ("All results" for text, "Open line" for an unknown full address)
  const opts: Opt[] = [];
  if (key && data) {
    data.items.forEach((s) => opts.push({ id: `${uid}-o${opts.length}`, kind: "line", token: s.token, sug: s })); // v6 lines live on our site too
    if (data.kind === "address" && !data.items.length) {
      // no listed token at this address: a wallet opens its profile; a contract may be an unlisted line;
      // unknown (chain didn't answer) offers both
      if (data.wallet !== false) {
        opts.push({ id: `${uid}-o${opts.length}`, kind: "wallet", token: key });
        opts.push({ id: `${uid}-o${opts.length}`, kind: "dev", token: key });
      }
      if (data.wallet !== true) opts.push({ id: `${uid}-o${opts.length}`, kind: "addr", token: key });
    }
    if (data.kind === "text" && data.items.length) opts.push({ id: `${uid}-o${opts.length}`, kind: "all" });
  }
  const shown = open && !!key && status !== "idle";
  const act = active >= 0 && active < opts.length ? active : -1;

  const closeSiteMenu = () => {
    for (const id of ["site-menu", "site-search"]) {
      const menu = document.getElementById(id) as HTMLDetailsElement | null;
      if (menu) menu.open = false;
    }
  };
  const done = () => {
    setOpen(false);
    setActive(-1);
    closeSiteMenu();
    (document.activeElement as HTMLElement | null)?.blur();
  };

  const go = (o: Opt) => {
    if (o.kind === "vibe" && o.token) {
      window.open(VIBE_TOKEN(o.token), "_blank", "noopener,noreferrer");
      done();
      return;
    }
    done();
    setQ("");
    if ((o.kind === "line" || o.kind === "addr") && o.token) router.push(`/line/${o.token}`);
    else if (o.kind === "wallet" && o.token) router.push(`/w/${o.token}`);
    else if (o.kind === "dev" && o.token) router.push(`/dev/${o.token}`);
    else if (o.kind === "all") router.push(`/?q=${encodeURIComponent(q.trim())}#board`);
  };

  // Enter with nothing highlighted: the old behaviour (address -> its line, text -> the board)
  const submit = () => {
    const text = q.trim();
    if (act >= 0) return go(opts[act]);
    if (FULL.test(text)) {
      const a = text.toLowerCase();
      // the answer for this address is in: a listed token opens its line, a wallet its profile
      if (data && key === a) {
        if (data.items[0]) return go({ id: "", kind: "line", token: data.items[0].token });
        if (data.wallet === true) return go({ id: "", kind: "wallet", token: a });
        return go({ id: "", kind: "addr", token: a });
      }
      // not in yet: ask once, then decide (a failed check falls back to the line page, which checks the chain)
      done();
      setQ("");
      fetch(`/api/search?q=${a}`)
        .then((r) => (r.ok ? (r.json() as Promise<Res>) : null))
        .catch(() => null)
        .then((j) => router.push(j && !j.items.length && j.wallet === true ? `/w/${a}` : `/line/${j?.items[0]?.token ?? a}`));
      return;
    }
    done();
    router.push(text ? `/?q=${encodeURIComponent(text)}#board` : "/");
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) setOpen(true);
      if (!opts.length) return;
      const d = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i < 0 ? (d > 0 ? 0 : opts.length - 1) : (i + d + opts.length) % opts.length));
    } else if (e.key === "Escape") {
      if (shown) {
        e.preventDefault();
        setOpen(false);
        setActive(-1);
      } else input.current?.blur();
    }
  };

  const row = (o: Opt, i: number) => {
    const s = o.sug;
    return (
      <li
        key={o.id}
        id={o.id}
        role="option"
        aria-selected={i === act}
        className={`${styles.sugRow} ${i === act ? styles.sugOn : ""}`}
        onMouseDown={(e) => e.preventDefault() /* keep focus in the box */}
        onMouseEnter={() => setActive(i)}
        onClick={() => go(o)}
      >
        {s ? (
          <>
            <TokenAvatar src={s.image} symbol={s.symbol} size={24} />
            <span className={styles.sugNames}>
              <b>${s.symbol || "???"}</b>
              <small>{s.name}</small>
            </span>
            <span className={styles.sugEnd}>{s.graduated ? "Graduated" : `${(s.progressBps / 100).toFixed(1)}%`}</span>
            <span className={styles.tag}>Token</span>
          </>
        ) : o.kind === "addr" ? (
          <span className={styles.sugNames}>
            <b className={styles.sugMono}>Open line {short(o.token ?? "")}</b>
            <small>Not in the directory: checks the chain</small>
          </span>
        ) : o.kind === "dev" ? (
          <span className={styles.sugNames}>
            <b className={styles.sugMono}>Dev passport {short(o.token ?? "")}</b>
            <small>Every launch by this wallet and what it did with its bag</small>
          </span>
        ) : o.kind === "wallet" ? (
          <span className={styles.sugNames}>
            <b className={styles.sugMono}>Wallet {short(o.token ?? "")}</b>
            <small>{data?.wallet === true ? "Positions, PnL, entries, funder" : "If it is a wallet: open its profile"}</small>
          </span>
        ) : (
          <span className={styles.sugNames}>
            <b>All results for “{q.trim()}”</b>
          </span>
        )}
        {o.kind === "all" && <span className={styles.sugEnd} aria-hidden>↵</span>}
        {o.kind === "addr" && <span className={styles.tag}>Token</span>}
        {o.kind === "wallet" && <span className={styles.tag}>Wallet</span>}
        {o.kind === "dev" && <span className={styles.tag}>Dev</span>}
      </li>
    );
  };

  const note =
    status === "loading" && !opts.length
      ? "Searching…"
      : status === "error"
        ? "Search isn't answering. Press Enter to search the board."
        : status === "limited"
          ? "Rate-limited. Try again in a few seconds."
          : status === "ok" && data && !data.items.length && data.kind !== "address"
            ? data.kind === "prefix"
              ? `No token starts with ${key}. Paste the full address.`
              : `No token matches “${q.trim()}”`
            : "";

  return (
    <form
      ref={form}
      role="search"
      className={`${styles.box} ${size === "lg" ? styles.lg : ""} ${className ?? ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onBlur={(e) => {
        if (!form.current?.contains(e.relatedTarget as Node | null)) {
          setOpen(false);
          setActive(-1);
        }
      }}
    >
      <span aria-hidden="true" data-search-icon className={styles.icon}>⌕</span>
      <input
        ref={input}
        type="search"
        role="combobox"
        aria-expanded={shown}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={shown && act >= 0 ? opts[act].id : undefined}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        id={id}
        autoFocus={autoFocus}
        placeholder={placeholder}
        aria-label="Search: token address, wallet address, $ticker or name"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="search"
      />
      {hotkey && <kbd aria-hidden="true">/</kbd>}
      {size === "lg" && (
        <button type="submit" className={styles.go}>
          Check <span aria-hidden>→</span>
        </button>
      )}
      <div className={styles.sug} hidden={!shown}>
        <ul id={listId} role="listbox" aria-label="Matching tokens" className={styles.sugList}>
          {shown && opts.map(row)}
        </ul>
        <p className={styles.sugNote} role="status" aria-live="polite">
          {shown ? note : ""}
        </p>
      </div>
    </form>
  );
}
