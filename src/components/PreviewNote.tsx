"use client";
// The "$EXIT isn't live" note. Only on the pages that show the $EXIT line, which replays another token
// before launch (/exit, /board, /hall, /t/<wallet>); elsewhere the data is real.
const LINE_PAGES = ["/exit", "/board", "/hall", "/t"];
import { usePathname } from "next/navigation";

export default function PreviewNote({ className }: { className?: string }) {
  const path = usePathname() || "";
  if (!LINE_PAGES.some((p) => path === p || path.startsWith(p + "/"))) return null;
  return (
    <div className={className} role="note">
      Preview · $EXIT isn&apos;t live yet. The line replays another vibe/vibe token to show how it works; those wallets are not $EXIT holders.
    </div>
  );
}
