import { permanentRedirect } from "next/navigation";

// /rankings is an alias: the Rankings page lives at /lines (old links keep working). ?tab= is carried over.
export default async function RankingsAlias({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const t = (await searchParams).tab;
  permanentRedirect(typeof t === "string" && /^[a-z]{1,12}$/.test(t) ? `/lines?tab=${t}` : "/lines");
}
