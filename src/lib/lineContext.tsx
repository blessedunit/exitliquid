"use client";
// Which line the live hero shows: null = $EXIT (/exit), otherwise any vibe/vibe token (/line/<token>).
import { createContext, useContext } from "react";

export type LineInfo = { name: string; symbol: string; image: string | null; creator: string };
/** A token's own description and links from vibe/vibe (absent = nothing to show, never a placeholder). */
export type TokenAbout = { description: string | null; links: { label: string; href: string }[] };
export type LineCtx = { token: string | null; info: LineInfo | null };

const Ctx = createContext<LineCtx>({ token: null, info: null });

export const LineProvider = Ctx.Provider;
export const useLineCtx = () => useContext(Ctx);

export const vibeTokenUrl = (token: string) => `https://testnet.vibevibe.fun/token/${token}`;
