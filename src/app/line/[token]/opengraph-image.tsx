// Share card of a token line: ticker + picture, the Line Health letter and four facts in words.
// Data: the vibe directory (launchInfo, cached 10 min) and the analytics engine's own cache (the same answer the
// page polls), under a short budget. What isn't back in time is drawn as "—", never as 0.
import { headers } from "next/headers";
import { isAddress } from "@/lib/ticket";
import { ACTIVE_TOKEN } from "@/lib/config";
import { launchInfo } from "@/lib/launches";
import { v6Launch } from "@/lib/v6";
import { analyticsFor } from "@/lib/analytics/engine";
import { buildFor } from "@/lib/service";
import { pct } from "@/lib/format";
import { cachedCard, CardFrame, clean, crowd, pixelAvatar, shortA, within, type CardChip, type CardFact, type Tone } from "@/lib/shareCard";

export const alt = "Line Health card: grade and front-of-line signals of a vibe/vibe token";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const BUDGET_MS = 8_000; // a cold token builds its line in the background; the card is drawn with what came back

const gradeTone = (g: string): Tone => (g === "A" || g === "B" ? "good" : g === "C" ? "plain" : "bad");

export default async function Image({ params }: { params: Promise<{ token: string }> }) {
  const { token: raw } = await params;
  if (!isAddress(raw)) return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  const token = raw.toLowerCase();
  if (token === ACTIVE_TOKEN) return new Response(null, { status: 307, headers: { location: "/exit/opengraph-image", "cache-control": "public, max-age=600" } });

  return cachedCard(await headers(), `line:${token}`, async () => {
    // buildFor is the line the analytics build reads first (one shared job): its curve progress is the chain's,
    // the same number the page shows (vibe's directory can lag by many points)
    const [info, a, built, people] = await Promise.all([
      within(launchInfo(token), 2_500),
      within(analyticsFor(token), BUDGET_MS),
      within(buildFor(token), BUDGET_MS),
      crowd(["hood", "bag", "plain"]),
    ]);
    // not in the v1 directory: maybe a taxed v6 launch (ticker and picture only, the v1 engine can't grade it)
    const v6 = !info ? await within(v6Launch(token), 2_000) : null;
    const v6Image = v6?.content?.image?.uri?.startsWith("ipfs://") ? `/ipfs/${v6.content.image.uri.slice(7).split("/")[0]}` : null;
    const symbol = clean(info?.symbol || v6?.symbol || a?.symbol || "", 12);
    const name = clean(info?.name || v6?.name || "", 26);
    const avatar = await pixelAvatar(info?.image ?? v6Image, 132);

    const h = a?.health ?? null;
    const bundle = a?.bundle.data ?? null;
    const supply = a?.supply.data ?? null;
    const meta = built && !built.unavailable && !built.stale ? built.meta : null;
    const graduated = !!(meta?.graduated || info?.graduated || a?.graduated);
    const progressBps = meta ? meta.progressBps : info ? info.progressBps : null;

    const facts: CardFact[] = [];
    // 1. snipers in the first buyers
    if (h && h.snipers !== null) {
      facts.push({ value: String(h.snipers), label: `${h.snipers === 1 ? "sniper" : "snipers"} in first ${h.firstBuyers}`, tone: h.snipers >= 12 ? "bad" : h.snipers >= 6 ? "warn" : "good" });
    } else facts.push({ value: "—", label: "snipers: unknown" });
    // 2. the dev's bag
    if (supply && supply.creatorPct !== null) {
      const sold = supply.devSells !== null && supply.devSells > 0;
      facts.push({ value: pct(supply.creatorPct), label: sold ? `dev holds · sold ${supply.devSells}×` : "dev holds", tone: supply.creatorPct >= 5 || sold ? "warn" : "plain" });
    } else facts.push({ value: "—", label: "dev bag: unknown" });
    // 3. walk to the door
    if (graduated) facts.push({ value: "100%", label: "graduated", tone: "good" });
    else if (progressBps !== null) facts.push({ value: pct(progressBps / 100), label: "to graduation", tone: progressBps >= 8_000 ? "good" : "plain" });
    else facts.push({ value: "—", label: "graduation: unknown" });
    // 4. bundles at launch
    if (bundle) facts.push({ value: pct(bundle.boughtPct), label: "bought in bundles", tone: bundle.boughtPct >= 20 ? "bad" : bundle.boughtPct >= 10 ? "warn" : "plain" });
    else facts.push({ value: "—", label: "bundles: unknown" });

    // the strongest other signals (bundle and snipers are already facts)
    const chips: CardChip[] = (a?.chips ?? [])
      .filter((c) => !c.quiet && (c.level === "high" || c.level === "mid") && c.id !== "BUNDLE" && c.id !== "SNP")
      .slice(0, 3)
      .map((c) => ({ label: clean(c.label, 24), tone: c.level === "high" ? "bad" : "warn" }));

    // one holders figure, as on the page: the chain's (Supply) once in, vibe's until then
    const nHolders = supply?.holders ?? (typeof info?.holders === "number" ? info.holders : null);
    const holders = nHolders !== null ? `${nHolders.toLocaleString("en-US")} holders` : null;
    const subtitle = [name, holders].filter(Boolean).join(" · ");
    const big = h
      ? { value: h.grade, label: "LINE HEALTH", sub: `${h.score}/100${h.partial ? " · partial" : ""}`, tone: gradeTone(h.grade), letter: true }
      : { value: "?", label: "LINE HEALTH", sub: v6 ? "taxed v6 launch: not graded" : "not read yet", tone: "plain" as Tone, letter: true };

    const full = !!(info && h && bundle && supply && (avatar !== null || !info.image));
    return {
      full,
      el: (
        <CardFrame
          kind={graduated ? "LINE · GRADUATED" : "LINE"}
          avatar={avatar}
          fallbackLetter={symbol || "?"}
          title={symbol ? `$${symbol}` : shortA(token)}
          subtitle={subtitle}
          chips={chips}
          big={big}
          facts={facts}
          path={`/line/${token.slice(0, 6)}…${token.slice(-4)}`}
          people={people}
        />
      ),
    };
  });
}
