// Shared site copy. The rules of the line live here once (the $EXIT line, /exit); they must match lib/queue.ts.
// [number, title, text]
export const RULES: [string, string, string][] = [
  ["1", "First in, first in line.", "Buy 0.0003 ETH+ of $EXIT and that buy sets your place. A first buy of 0.003 ETH+ gives +1 point to everyone ahead of you. The chain keeps the order."],
  ["2", "Leave and your points go to the ones behind you.", "Sell 95% of your bag and you walk out."],
  ["3", "Come back and you start at the end.", "No cutting. A second entry starts at the back."],
  ["4", "The door opens at graduation.", "When the curve fills (5 ETH), the token moves to a DEX pool."],
];
