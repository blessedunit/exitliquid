import { getMood } from "@/lib/mood";

export const dynamic = "force-dynamic";

export async function GET() {
  const mood = await getMood();
  // an "unknown" answer must not sit in the CDN for 15 minutes
  const cc = mood.mood === "unknown" ? "public, s-maxage=60" : "public, s-maxage=300, stale-while-revalidate=3600";
  return Response.json(mood, { headers: { "cache-control": cc } });
}
