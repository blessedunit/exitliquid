"use client";
// One try counter for every poll that can fail (analytics, health, holders, the line, v6, the market board).
// While tries are left the caller keeps its loading state and asks again by itself; after MAX_TRIES failures
// in a row it stops asking and shows <Unreadable failed={...} />: one line, the time of the last try, "Try again".
import { useCallback, useMemo, useRef, useState } from "react";

export const MAX_TRIES = 5;
/** the read gave up: when the last try was, and how to start over */
export type Failed = { at: number; again: () => void };

export function useTries(key: string | null) {
  const [stop, setStop] = useState<{ key: string | null; at: number } | null>(null);
  const [round, setRound] = useState(0);
  const n = useRef(0);
  /** a new poll loop starts (call first in the effect) */
  const start = useCallback(() => { n.current = 0; setStop(null); }, []);
  /** a failed try. true = ask again; false = that was the last one, stop asking */
  const fail = useCallback((k: string | null) => {
    if (++n.current < MAX_TRIES) return true;
    setStop({ key: k, at: Date.now() });
    return false;
  }, []);
  /** a good answer */
  const ok = useCallback(() => { n.current = 0; setStop(null); }, []);
  const again = useCallback(() => { n.current = 0; setStop(null); setRound((r) => r + 1); }, []);
  // a give-up for another key (the page switched tokens) is never shown
  const at = stop && stop.key === key ? stop.at : null;
  const failed = useMemo<Failed | null>(() => (at === null ? null : { at, again }), [at, again]);
  /** `round` goes into the poll effect's deps: "Try again" restarts the loop */
  return { failed, round, start, fail, ok };
}
