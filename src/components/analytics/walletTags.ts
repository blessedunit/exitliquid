// Wallet tags shown on the tape and the ticket (from the analytics answer's `tags`).
import type { HolderFlag, WalletTag } from "@/lib/analytics/types";

export const TAG_TEXT: Record<WalletTag, string> = { dev: "Dev", sniper: "Sniper", farm: "Farm", gifted: "Gifted" };
export const TAG_HINT: Record<WalletTag, string> = {
  dev: "The token's creator",
  sniper: "Known sniper bot (Early Index: first-20 buyer of many launches)",
  farm: "Wallet of a known farm group (Early Index)",
  gifted: "Most of its bag came by transfer, not a buy",
};
/** red square for bots, a light one for a signal, a grey one for plain facts (spec 1.6) */
export const TAG_TONE: Record<WalletTag, "bad" | "warn" | "plain"> = { dev: "plain", sniper: "bad", farm: "warn", gifted: "warn" };

/** per-wallet flags from the Supply read (top 10), shown as tags in Top holders (cluster and creator have their own marks there) */
export const FLAG: Record<HolderFlag, { text: string; tone: "bad" | "warn" | "plain"; hint: string }> = {
  creator: { text: "Dev", tone: "plain", hint: "The token's creator" },
  gifted: { text: "Gifted", tone: "warn", hint: "Most of this bag came by transfer, not a buy" },
  fresh: { text: "Fresh", tone: "warn", hint: "First ETH arrived less than 24 h before its first buy" },
  cluster: { text: "One funder", tone: "bad", hint: "Shares a first funder with other top holders" },
  lownonce: { text: "≤2 tx", tone: "warn", hint: "This wallet has sent 2 transactions or fewer" },
  sniper: { text: "Sniper", tone: "bad", hint: "Known sniper bot (Early Index)" },
  farm: { text: "Farm", tone: "warn", hint: "Farm group wallet (Early Index)" },
};
