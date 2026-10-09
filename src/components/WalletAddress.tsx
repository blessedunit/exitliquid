"use client";

import { useState } from "react";
import { EXPLORER } from "@/lib/config";
import { short } from "@/lib/queue";
import PixelIcon from "./PixelIcon";
import styles from "./WalletAddress.module.css";

export default function WalletAddress({ wallet }: { wallet: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(wallet);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch { setCopied(false); }
  };
  return <span className={styles.wallet}>
    <a href={`${EXPLORER}/address/${wallet}`} target="_blank" rel="noreferrer" title={`View ${wallet} on explorer`}>{short(wallet)} ↗</a>
    <button type="button" onClick={copy} title={copied ? "Copied" : "Copy full address"} aria-label={`Copy wallet address ${wallet}`}><i className={styles.glyphPhone}>{copied ? "✓" : "▣"}</i><i className={styles.glyphDesk}><PixelIcon name={copied ? "check" : "copy"} /></i></button>
  </span>;
}
