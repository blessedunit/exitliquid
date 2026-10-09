"use client";
// Re-reads the status every 30 s while the tab is visible (the probes themselves are shared server-side for 15 s).
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function Refresh({ everyMs = 60_000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, everyMs);
    return () => clearInterval(t);
  }, [router, everyMs]);
  return null;
}
