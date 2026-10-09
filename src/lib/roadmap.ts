// The Evacuation Map (roadmap). Honest status only, shown as Built / Building / Idea.
// No dates we can't keep, no promises of value.

export type RoomStatus = "done" | "now" | "next" | "later";

export type Room = {
  id: string;
  code: string; // wayfinding code shown on the plan
  name: string;
  status: RoomStatus;
  items: string[];
};

export const ROOMS: Room[] = [
  {
    id: "lobby",
    code: "R1",
    name: "Lobby",
    status: "done",
    items: ["Manifesto and rules of the line", "The 8-bit cast: five ranks, the Dev, the Ghost", "This site and the X account"],
  },
  {
    id: "ticket",
    code: "R2",
    name: "Ticket Office",
    status: "now",
    // max 4 items of <= 31 characters per room: the SVG rooms have a fixed size (components/EvacMap.tsx)
    items: ["$EXIT line on vibe/vibe", "Line read straight from chain", "My Lines tracker (built)", "Line moves: walk-in, walk-out"],
  },
  {
    id: "arcade",
    code: "R3",
    name: "Arcade",
    status: "done",
    items: ["Departures board for every vibe/vibe launch", "Token lines, X-ray and top holders", "Market Mood from real stock moves"],
  },
  {
    id: "hall",
    code: "R4",
    name: "Hall of Exits",
    status: "done",
    items: ["Every exit recorded with its place", "Named groups: Front Door to the Block", "Idea: one stamp per ticket"],
  },
  {
    id: "stairs",
    code: "R5",
    name: "Stock Stairwell",
    status: "next",
    items: ["Built: stock pockets badge", "Stock-pair mode", "Line skins", "Hall of Fame + 8-bit sound"],
  },
  {
    id: "radar",
    code: "R6",
    name: "Radar Room",
    status: "next",
    items: ["A share card for your place in any vibe line", "Launch feed: who just got in, who just left", "Daily line card on X"],
  },
  {
    id: "door",
    code: "E1",
    name: "Door",
    status: "later",
    items: ["Bonding curve completes", "Graduation to a DEX pool", "Ranks follow the pool price", "Nobody knows what's outside. That's the joke."],
  },
];

export const STATUS_LABEL: Record<RoomStatus, string> = {
  done: "Built",
  now: "Building",
  next: "Idea",
  later: "Idea",
};
