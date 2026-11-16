import { permanentRedirect } from "next/navigation";

// /launches was the same board as "/": old links (with their ?tab=, ?q=, ?sort=) land on the home board.
export default async function LaunchesRedirect({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) {
    const one = Array.isArray(v) ? v[0] : v;
    if (one) qs.set(k, one);
  }
  const q = qs.toString();
  permanentRedirect(q ? `/?${q}` : "/");
}
