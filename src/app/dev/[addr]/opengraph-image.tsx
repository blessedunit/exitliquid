// Share card of a creator: launches · graduated, the passport's badges and how the dev treats their bag.
// Data: devPassport (memoized, the same read the page shows) under a short budget; "—" = unknown, never 0.
import { headers } from "next/headers";
import { devPassport, fmtDuration, type Fact } from "@/lib/devrep";
import { fmtAge, fmtEth, pct } from "@/lib/format";
import { cachedCard, CardFrame, clean, crowd, shortA, sprite, within, type CardChip, type CardFact, type Tone } from "@/lib/shareCard";

export const alt = "Dev passport card: launches, graduations and dev-bag habits of a vibe/vibe creator";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);
const FACT_TONE: Record<Fact["tone"], Tone> = { good: "good", info: "plain", warn: "warn", bad: "bad" };

export default async function Image({ params }: { params: Promise<{ addr: string }> }) {
  const { addr } = await params;
  if (!isAddr(addr)) return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  const a = addr.toLowerCase();

  return cachedCard(await headers(), `dev:${a}`, async () => {
    const [p, face, people] = await Promise.all([within(devPassport(a), 7_000), sprite("architect", 2), crowd(["suit", "bag", "plain"])]);

    // vibe's lists leave the first and legacy factories out: the chain's count wins when it is higher (as the page does)
    const n = p ? (p.onChain ? p.onChain.launches : p.total ?? p.loaded) : null;
    // taxed v6 not covered and nothing else listed: unknown, not "0"
    const v6Gap = !!p && p.coverage === "v1-only" && p.loaded === 0 && !p.onChain;
    const nText = p && !v6Gap ? (p.onChain ? String(p.onChain.launches) : p.total === null ? `${p.loaded}+` : String(p.total)) : "—";
    const grads = p ? (p.onChain ? p.onChain.grads : p.graduated) : null;
    const s = p?.summary ?? null;
    const chain = p?.chain === "ok";
    const last = p?.launches.find((l) => l.createdAt > 0)?.createdAt ?? null;
    const week = p ? p.launches.filter((l) => l.createdAt > Date.now() / 1000 - 7 * 86_400).length : 0;

    const chips: CardChip[] = (p?.facts ?? []).slice(0, 4).map((f) => ({ label: clean(f.label, 26), tone: FACT_TONE[f.tone] }));
    const facts: CardFact[] = [
      grads !== null && n
        ? { value: pct((grads / n) * 100), label: "of launches graduated", tone: grads > 0 ? "good" : "plain" }
        : { value: "—", label: "graduation rate: unknown" },
      chain && s && s.devHeld !== null && s.soldIn !== null
        ? s.devHeld === 0
          ? { value: "0", label: "launches with a dev bag" }
          : { value: `${s.soldIn}/${s.devHeld}`, label: "dev bags sold", tone: s.soldIn * 2 >= s.devHeld ? "warn" : "plain" }
        : { value: "—", label: "dev sells: unknown" },
      s && s.medianFirstSell !== null
        ? { value: fmtDuration(s.medianFirstSell), label: "to first dev sell", tone: s.medianFirstSell <= 600 ? "bad" : "plain" }
        : chain && s && s.soldIn === 0 && s.heldThroughGrad !== null && s.heldThroughGrad > 0
          ? { value: String(s.heldThroughGrad), label: "held through graduation", tone: "good" }
          : p
            ? { value: String(week), label: "launches in 7 days", tone: week >= 5 ? "warn" : "plain" }
            : { value: "—", label: "first sell: unknown" },
      p && p.fees.totalWei !== null
        ? { value: fmtEth(Number(BigInt(p.fees.totalWei) / 10n ** 12n) / 1e6), label: `ETH creator fees${p.fees.status === "partial" ? " · partial" : ""}` }
        : { value: "—", label: "fees: unknown" },
    ];

    const big = p
      ? { value: nText, label: "LAUNCHES", sub: `${grads ?? "—"} graduated${p.onChain ? " (chain)" : p.total !== null && p.total > p.loaded ? ` of last ${p.loaded}` : ""}`, tone: "plain" as Tone }
      : { value: "—", label: "LAUNCHES", sub: "unknown right now", tone: "plain" as Tone };

    const full = !!(p && !p.stale && chain && p.fees.status !== "unknown");
    return {
      full,
      el: (
        <CardFrame
          kind="DEV PASSPORT"
          avatar={null}
          avatarSprite={face}
          title={shortA(a)}
          subtitle={last ? `vibe/vibe creator · last launch ${fmtAge(Date.now() / 1000 - last)} ago` : "vibe/vibe creator"}
          chips={chips}
          big={big}
          facts={facts}
          path={`/dev/${a.slice(0, 6)}…${a.slice(-4)}`}
          people={people}
        />
      ),
    };
  });
}
