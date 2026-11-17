# Changelog

## 2026-11-17 · Grades rebuilt on outcomes
- The grade was audited against what actually happened to tokens after they were graded, and rebuilt (rules v11): the letter is the risk of becoming someone's exit liquidity, with a separate Full check / Partial marker.
- New checks: one wallet buying a big share of supply and dumping it (graduation pumps), volume concentration in the top wallets, round-trip trades within 5 minutes, pool liquidity after graduation, price versus the launch price.
- Holders now count wallets that bought and hold more than dust; airdrop-only wallets are excluded.
- Pool buys through the second v6 factory's router are now counted.
- New vocabulary: No red flags found · Minor flags · Caution · High risk · Likely exit liquidity; no letter = Too new / Not enough trading yet / Couldn't read.
- Launches board: fixed one-line token subtitle, tabs New · Hot · Near graduation · Graduated · Watchlist, Hide high risk toggle.
- The grader now covers active tokens across the whole launchpad, not only the last day.
- Next.js 16.4.6.

## 2026-11-16 · One grade, fewer pages
- One A–F grade everywhere (token page, rankings, share card), with the facts behind it. Tokens with fewer than 10 holders cap at C; unchecked snipers or dev history cap at B; nothing unknown is ever counted as clean.
- The token page leads with the grade and the line: snipers, farms and bundles are marked on the traders in the line; one row of key numbers; short sections.
- Second v6 factory supported; all factory addresses now live in one file (`src/data/factories.json`).
- Failed reads stop after five tries with "Can't read this token right now" and a Try again button, instead of retrying forever.
- New loading animation: our pixel traders redrawn in ASCII, walking into the EXIT door.
- Removed pages merged or redirected: Graduation watch, Hall, FAQ, kit, map, dev passport (now on the wallet page).

## 2026-10-09 · Minimal redesign, everything open
- Cleaner, quieter interface: one type scale, fewer frames and badges, the pixel art kept as an accent.
- All analytics open to everyone: no wallet, token or sign-in needed to see Line Health, holders, bundles or volume.
- Creators who launched through the taxed v6 factory now show their launches on the dev passport.

## 2026-10-07 · Share cards, Graduation watch, live sniper index
- Share cards for tokens, wallets and devs (post to X, copy link, download PNG).
- **Graduation watch** (`/door`): tokens near the door with live progress and ETA, plus a "just graduated" feed.
- The Early Index (sniper bots and farm groups) now refreshes every hour across all four launch factories.
- Weekly **State of vibe** card (`/state/card`).

## 2026-10-05 · Chain reads under the new RPC limits
- The public node now caps `eth_getLogs` ranges. Every history read is sliced to fit, and wallet history comes from Blockscout.
- Longer CDN caching and slower polling, so the site stays light.

## 2026-10-03 · Clarity pass
- Home page explains the site in one line, with four entry points: check a token, track a wallet, vet a dev, see the market.
- Token page opens with a 3-second summary, then sections: Line · Risk · Holders · Selling · Dev.
- Tooltips explain every term in place.

## 2026-10-01 · Pro analytics
- Bundle check, "Who's selling to you" exit maths, real volume, clean top-10, gifted and fresh holders, clone detection.
- Wallet profiles (`/w/<address>`), dev passports (`/dev/<address>`), **State of vibe** (`/state`), Methodology and Status pages.

## 2026-09-30 · The departures board
- A live board of every vibe/vibe launch with mini-lines, progress to the door and ETA.
- A page for every token: the pixel corridor of holders, the live tape, a ticket for every wallet.
- **Line Health** (A–F), built on the first Early Index of sniper bots and farm groups.

## 2026-09 · The $EXIT line
- The original meme: an on-chain line of $EXIT holders in buy order, with points, the Hall of Exits and the manifesto.
