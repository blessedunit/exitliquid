"use client";
// The one end state of a read that keeps failing: "Can't read this token right now. Last try HH:MM." + Try again.
// Never a zero, never "not a vibe launch". With `failed` (from useTries) it is one line inside a card; without
// it, it is the whole page for a launch the server couldn't read: the page is asked again MAX_TRIES times first.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { MAX_TRIES, type Failed } from "@/components/useTries";
import Loader from "@/components/ui/Loader";

const EVERY_MS = 15_000;
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export default function Unreadable({ failed, what = "this token", className }: { failed?: Failed | null; what?: string; className?: string }) {
  if (failed === undefined) return <UnreadablePage />;
  if (!failed) return null;
  return (
    <p className={className} role="status">
      Can&apos;t read {what} right now. Last try {hhmm(failed.at)}.{" "}
      <button type="button" className="btn small" onClick={failed.again}>Try again</button>
    </p>
  );
}

function UnreadablePage() {
  const router = useRouter();
  // the server render that put this page here was try 1
  const [tries, setTries] = useState(1);
  const [at, setAt] = useState<number | null>(null);
  const done = tries >= MAX_TRIES;
  useEffect(() => {
    if (done) return;
    const t = setTimeout(() => {
      setAt(Date.now());
      setTries((n) => n + 1);
      router.refresh(); // a readable token replaces this page; an unreadable one keeps it (and its count)
    }, EVERY_MS);
    return () => clearTimeout(t);
  }, [done, tries, router]);
  return (
    <section className="wrap" style={{ padding: "64px 16px", textAlign: "center" }}>
      {done && at !== null
        ? <Unreadable failed={{ at, again: () => { setTries(1); router.refresh(); } }} />
        : <Loader caption="Reading the chain…" center />}
    </section>
  );
}
