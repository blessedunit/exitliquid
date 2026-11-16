// vibe/vibe contracts: every list in the site comes from src/data/factories.json (ops/early_index.py reads the
// same file). A new factory or hook is added there, never here and never in a consumer.
import type { Address } from "viem";
import data from "@/data/factories.json";

type Entry = { address: string; version?: string; plumbing?: string; name?: string; id?: string; learned?: boolean };
export type Factory = { id: string; version: "v1" | "v6"; address: string; from: number; label: string };

const low = (a: string) => a.toLowerCase();
const all: Entry[] = [...data.factories, ...data.hooks, ...data.plumbing];
const plumbingOf = (set: "v1" | "v6") => all.filter((e) => e.plumbing === set).map((e) => low(e.address));

/** every launch factory, in file order */
export const FACTORIES: Factory[] = data.factories.map((f) => ({ id: f.id, version: f.version as "v1" | "v6", address: low(f.address), from: f.from, label: f.label }));
/** curve factories: LaunchCreated(id, token, curve; creator in data) */
export const V1_FACTORIES = FACTORIES.filter((f) => f.version === "v1").map((f) => f.address as Address);
/** taxed factories: LaunchCreated(id, launcher, token; curve in data) */
export const V6_FACTORIES = FACTORIES.filter((f) => f.version === "v6").map((f) => ({ address: f.address, from: f.from }));
/** pool hooks trusted as vibe's without a check (lib/state.ts checks any other hook itself) */
export const GRAD_HOOKS = (data.hooks as Entry[]).filter((h) => !h.learned).map((h) => low(h.address));
/** protocol contracts that move tokens but are never people */
export const PLUMBING = plumbingOf("v1");
/** protocol contracts every v6 token marks as non-holders at launch. Never people. */
export const V6_PLUMBING = plumbingOf("v6");
const byId = (id: string) => low((data.plumbing as Entry[]).find((p) => p.id === id)!.address);
export const V6_ZAP = byId("v6zap");
/** Uniswap V4 PoolManager: graduated tokens trade in its pools */
export const POOL_MANAGER = byId("poolManager");
/** names shown on wallet pages */
export const PLUMBING_NAMES: Record<string, string> = Object.fromEntries(all.filter((e) => e.name).map((e) => [low(e.address), e.name as string]));
