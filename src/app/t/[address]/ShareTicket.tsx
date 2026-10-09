"use client";
import { useState } from "react";
import type { TicketResponse } from "@/lib/types";
import { PUBLIC_SITE_URL, VIBE_X, X_HANDLE, X_LIVE } from "@/lib/config";

function shareUrl(t: TicketResponse) {
  // version key so X re-fetches the card when the place changes
  const v = t.entry ? `p${t.entry.place}` : t.status;
  return `${PUBLIC_SITE_URL}/t/${t.wallet.toLowerCase()}?v=${v}`;
}

function shareText(t: TicketResponse) {
  if (t.status === "in_line")
    return `I'm #${Math.trunc(t.entry!.place)} in the ${t.mode === "live" ? "$EXIT" : "preview"} line.\n${Math.trunc(t.entry!.ahead)} ahead of me · ${Math.trunc(t.entry!.behind)} behind me.\n\nThanks for the liquidity, @${VIBE_X}.\nGet in line →`;
  if (t.status === "exited")
    return `I exited the $EXIT line at #${Math.trunc(t.exit!.exitedAtPlace)}.\n${Math.trunc(t.exit!.behindAtExit)} people moved up.\n\nThanks for the liquidity, @${VIBE_X}.`;
  return `not in the $EXIT line yet. somewhere a door is waiting. @${VIBE_X}`;
}

export default function ShareTicket({ t }: { t: TicketResponse }) {
  const [copied, setCopied] = useState(false);
  const [pngCopied, setPngCopied] = useState(false);
  const [copyingPng, setCopyingPng] = useState(false);
  const [shareHint, setShareHint] = useState("");
  return (
    <div className="shareRow" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      <button
        className="btn"
        type="button"
        onClick={() => {
          const via = X_LIVE ? `&via=${X_HANDLE}` : "";
          const intent = `https://x.com/intent/tweet?text=${encodeURIComponent(shareText(t))}&url=${encodeURIComponent(shareUrl(t))}${via}`;
          setShareHint("");
          window.open(intent, "_blank", "noopener,noreferrer");
        }}
      >
        Share on X
      </button>
      <button
        className="btn quiet"
        type="button"
        disabled={copyingPng}
        onClick={async () => {
          setShareHint("");
          if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
            setShareHint("PNG copying is unavailable in this browser.");
            return;
          }
          setCopyingPng(true);
          try {
            // Start clipboard access in the click gesture. The promised PNG is rendered
            // from the actual pass on screen, including its current live PNL.
            const png = (async () => {
              const card = document.getElementById("boarding-pass");
              if (!card) throw new Error("Pass unavailable");
              await document.fonts.ready;
              const { toBlob } = await import("html-to-image");
              const blob = await toBlob(card, { pixelRatio: 2, backgroundColor: "#0f1211" });
              if (!blob) throw new Error("PNG unavailable");
              return blob;
            })();
            await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
            setPngCopied(true);
            setTimeout(() => setPngCopied(false), 1600);
          } catch {
            setShareHint("Couldn't copy the full pass. Check browser clipboard permissions and try again.");
          } finally {
            setCopyingPng(false);
          }
        }}
      >
        {copyingPng ? "Copying…" : pngCopied ? "PNG copied" : "Copy PNG"}
      </button>
      <button
        className="btn quiet"
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(shareUrl(t));
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          } catch {
            /* clipboard blocked */
          }
        }}
      >
        {copied ? "Copied" : "Copy link"}
      </button>
      {shareHint && <p role="status" style={{ flexBasis: "100%", margin: 0, color: "var(--muted)", fontSize: 13 }}>{shareHint}</p>}
    </div>
  );
}
