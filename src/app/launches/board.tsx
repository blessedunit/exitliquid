// The Live launches board as a server component, shared by "/" and /launches (both render the same board).
// Rendered on the server with the first page of the list in the URL already inside: no empty skeleton on
// arrival, and "back" from a line lands on the same tab/sort/search. The vibe calls behind it sit in the
// shared data cache (15 s) and a short memo, so a per-request render costs no extra upstream traffic.
// "/" also gets the hero (HomeIntro): its market numbers never hold the board (300 ms at most).
import { cookies } from "next/headers";
import Launches from "./Launches";
import HomeIntro, { type IntroMarket, type IntroMode } from "@/components/home/HomeIntro";
import { launchPage, type LaunchPage } from "@/lib/launches";
import { peekState } from "@/lib/state";
import { parseBoard } from "./state";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

async function introMarket(): Promise<IntroMarket> {
  try {
    const s = await Promise.race([peekState().catch(() => null), new Promise<null>((res) => setTimeout(() => res(null), 300))]);
    return s ? { launches7d: s.totals.launches7d, grads7d: s.totals.grads7d } : null;
  } catch {
    return null; // the tile shows —, never 0
  }
}

async function introMode(): Promise<IntroMode> {
  try {
    const v = (await cookies()).get("el_intro")?.value;
    return v === "seen" || v === "min" ? "min" : "full";
  } catch {
    return "full";
  }
}

export async function DeparturesPage({ searchParams, intro = false }: { searchParams: SearchParams; intro?: boolean }) {
  const raw = await searchParams;
  const board = parseBoard({ get: (k) => (typeof raw[k] === "string" ? (raw[k] as string) : null) });
  let first: LaunchPage | null = null;
  const heroP = intro ? Promise.all([introMarket(), introMode()]) : null;
  if (board.tab !== "watch") {
    try {
      // same limit as /api/launches: the first page the poll refreshes is exactly the page rendered here
      // but never hold the whole page for a slow list (Near graduation takes vibe 6-9 s): after 3 s the board
      // arrives with its skeleton and loads the list itself (the server call keeps filling the cache)
      first = await Promise.race([
        launchPage(board.tab, board.q.replace(/^\$/, ""), null, 24).catch(() => null),
        new Promise<null>((res) => setTimeout(() => res(null), 3_000)),
      ]);
    } catch {
      first = null; // the client retries; unknown, never "no launches"
    }
  }
  const hero = heroP ? await heroP : null;
  return (
    <section>
      <div className="wrap" style={{ maxWidth: "var(--maxw, 1280px)" }}>
        {hero && <HomeIntro market={hero[0]} initial={hero[1]} />}
        <Launches initial={first} board={board} home={intro} />
      </div>
    </section>
  );
}
