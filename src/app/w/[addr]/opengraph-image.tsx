// Share card of a wallet: its tags, season PnL (vibe's board) and how early it gets in.
// Data: walletProfile / walletEntries (memoized engines the page uses) under a short budget; "—" = unknown, never 0.
import { headers } from "next/headers";
import { walletEntries, walletProfile, type TagTone } from "@/lib/walletProfile";
import { fmtAge, fmtCompact, fmtEth } from "@/lib/format";
import type { Skin } from "@/lib/skins";
import { cachedCard, CardFrame, clean, crowd, shortA, sprite, within, type CardChip, type CardFact, type Tone } from "@/lib/shareCard";

export const alt = "Wallet card: tags, season PnL and early entries of a vibe/vibe wallet";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);
const TAG_TONE: Record<TagTone, Tone> = { risk: "bad", warn: "warn", good: "good", dev: "plain", info: "plain" };

export default async function Image({ params }: { params: Promise<{ addr: string }> }) {
  const { addr } = await params;
  if (!isAddr(addr)) return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  const w = addr.toLowerCase();

  return cachedCard(await headers(), `w:${w}`, async () => {
    const [prof, ent, people] = await Promise.all([within(walletProfile(w), 7_000), within(walletEntries(w), 5_000), crowd(["plain", "getaway", "hood"])]);
    const ids = new Set(prof?.tags.map((t) => t.id) ?? []);
    const skin: Skin = ids.has("sniper") ? "getaway" : ids.has("dev") ? "architect" : ids.has("farm") ? "hood" : ids.has("contract") || ids.has("plumbing") ? "suit" : "plain";
    const face = await sprite(skin, 2);

    const chips: CardChip[] = (prof?.tags ?? []).slice(0, 4).map((t) => ({ label: clean(t.label, 26), tone: TAG_TONE[t.tone] }));
    if (prof && !chips.length) chips.push({ label: "No flags", tone: "plain" });

    const tr = prof?.trader ?? null;
    const pnl = tr?.status === "ok" ? tr.pnlEth : null;
    // season board down: the open bags' PnL from positions (vibe positionLens) is the honest fallback, labelled as such
    const pos = prof?.positions.status === "ok" ? prof.positions.totals : null;
    const open = pnl === null || pnl === undefined ? (pos?.unrealizedEth ?? null) : null;
    const signed = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${fmtEth(Math.abs(v))}`;
    const toneOf = (v: number): Tone => (v > 0 ? "good" : v < 0 ? "bad" : "plain");
    const big =
      pnl !== null && pnl !== undefined
        ? { value: signed(pnl), label: "SEASON PNL", sub: `ETH, realized + open${tr?.complete === false ? " · partial" : ""}`, tone: toneOf(pnl) }
        : open !== null
          ? { value: signed(open), label: "OPEN PNL", sub: `ETH on bags still held${pos && pos.incomplete > 0 ? " · partial" : ""}`, tone: toneOf(open) }
          : { value: "—", label: "SEASON PNL", sub: tr?.status === "absent" ? "not on the season board" : "unknown right now", tone: "plain" as Tone };

    const act = prof && prof.activity.status !== "unavailable" ? prof.activity : null;
    const e = ent && ent.status === "ok" && ent.checked > 0 ? ent : null;
    const facts: CardFact[] = [
      e
        ? { value: `${e.first20}/${e.checked}`, label: "entries in the first 20", tone: e.first20Rate !== null && e.first20Rate >= 0.5 ? "warn" : "plain" }
        : { value: "—", label: "early entries: unknown" },
      act ? { value: fmtCompact(act.bought), label: "launches bought" } : { value: "—", label: "launches: unknown" },
      act ? { value: fmtCompact(act.holding), label: "still holding" } : { value: "—", label: "holding: unknown" },
      act && act.medianHoldSec !== null ? { value: fmtAge(act.medianHoldSec), label: "median hold", tone: act.medianHoldSec < 3600 ? "warn" : "plain" } : { value: "—", label: "median hold: unknown" },
    ];

    const rank = tr?.status === "ok" && tr.rank !== null ? `season rank #${tr.rank.toLocaleString("en-US")}${tr.of ? ` of ${fmtCompact(tr.of)}` : ""}` : "vibe/vibe wallet";
    const full = !!(prof && !prof.partial && e && ent?.pending === 0);
    return {
      full,
      el: (
        <CardFrame
          kind="WALLET"
          avatar={null}
          avatarSprite={face}
          title={shortA(w)}
          subtitle={rank}
          chips={chips}
          big={big}
          facts={facts}
          path={`/w/${w.slice(0, 6)}…${w.slice(-4)}`}
          people={people}
        />
      ),
    };
  });
}
