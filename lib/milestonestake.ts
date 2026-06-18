import { ethers } from "ethers";
import { ARC_RPC } from "./arcNetwork";

// ─────────────────────────────────────────────────────────────
// MilestoneStake — programmable milestone escrow on ARC.
// ─────────────────────────────────────────────────────────────
export const CONTRACT_ADDRESS = "0xfdB517E4deE1c17cA39196C7fB291D064C1F2CB0";

export const MILESTONESTAKE_ABI = [
  "function createEscrow(address contractor, string title, uint256 customerStake, uint256 contractorStake, uint16 penaltyBps, uint16[] weightsBps, uint64[] deadlines) returns (uint256)",
  "function fund(uint256 id) payable",
  "function confirmMilestone(uint256 id, uint8 i)",
  "function releaseOrPenalize(uint256 id, uint8 i)",
  "function claim()",
  "function cancel(uint256 id)",
  "function escrowCount() view returns (uint256)",
  "function totalPool() view returns (uint256)",
  "function totalReleased() view returns (uint256)",
  "function totalPenalized() view returns (uint256)",
  "function claimable(address) view returns (uint256)",
  "function getEscrow(uint256) view returns (tuple(uint256 id, address customer, address contractor, string title, uint256 customerStake, uint256 contractorStake, uint256 pool, uint256 distributed, uint256 relAmt, uint256 penAmt, uint16 penaltyBps, uint8 n, uint8 resolved, uint8 status, bool customerFunded, bool contractorFunded, uint64 createdAt))",
  "function milestonesOf(uint256) view returns (tuple(uint16 weightBps, uint64 deadline, uint64 confirmedAt, bool confirmed, uint8 state)[])",
  "function shareOf(uint256, uint8) view returns (uint256)",
  "function report(uint256) view returns (uint256 pool, uint256 released, uint256 penalized, uint256 remaining)",
  "function escrowsOfCustomer(address) view returns (uint256[])",
  "function escrowsOfContractor(address) view returns (uint256[])",
  "event EscrowCreated(uint256 indexed id, address indexed customer, address indexed contractor, string title, uint256 pool, uint8 n)",
  "event Funded(uint256 indexed id, address indexed who, uint256 amount, bool active)",
  "event Confirmed(uint256 indexed id, uint8 milestone, uint64 at)",
  "event Resolved(uint256 indexed id, uint8 milestone, uint8 state, uint256 toContractor, uint256 toCustomer)",
  "event Claimed(address indexed who, uint256 amount)",
];

export const PENDING = 0, ACTIVE = 1, DONE = 2, CANCELLED = 3;
export const M_OPEN = 0, M_RELEASED = 1, M_PENALIZED = 2;
export const MAX = 60;

export interface Milestone {
  weightBps: number;
  deadline: number;
  confirmedAt: number;
  confirmed: boolean;
  state: number;
  amount: bigint; // computed client-side: pool * weightBps / 10000
}

export interface Escrow {
  id: number;
  customer: string;
  contractor: string;
  title: string;
  pool: bigint;
  distributed: bigint;
  relAmt: bigint;
  penAmt: bigint;
  penaltyBps: number;
  n: number;
  resolved: number;
  status: number;
  customerFunded: boolean;
  contractorFunded: boolean;
  createdAt: number;
  milestones: Milestone[];
}

export interface Stats { escrows: number; pool: bigint; released: bigint; penalized: bigint; }
export const EMPTY_STATS: Stats = { escrows: 0, pool: 0n, released: 0n, penalized: 0n };

export function readProvider() { return new ethers.JsonRpcProvider(ARC_RPC); }
export function readContract(p?: ethers.Provider) { return new ethers.Contract(CONTRACT_ADDRESS, MILESTONESTAKE_ABI, p ?? readProvider()); }
export function hasContract(): boolean { return /^0x[a-fA-F0-9]{40}$/.test(CONTRACT_ADDRESS); }

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    const s = await Promise.allSettled(items.slice(i, i + limit).map(fn));
    s.forEach((r) => { if (r.status === "fulfilled") out.push(r.value); });
  }
  return out;
}

export async function fetchEscrow(id: number, contract?: ethers.Contract): Promise<Escrow | null> {
  const c = contract ?? readContract();
  try {
    const e = await c.getEscrow(id);
    if (e.customer === ethers.ZeroAddress) return null;
    const pool = e.pool as bigint;
    const raw = await c.milestonesOf(id);
    // last milestone absorbs dust (pool - sum of earlier shares)
    let acc = 0n;
    const milestones: Milestone[] = raw.map((m: { weightBps: bigint; deadline: bigint; confirmedAt: bigint; confirmed: boolean; state: bigint }, i: number) => {
      const isLast = i === raw.length - 1;
      const amt = isLast ? pool - acc : (pool * BigInt(m.weightBps)) / 10000n;
      if (!isLast) acc += amt;
      return { weightBps: Number(m.weightBps), deadline: Number(m.deadline), confirmedAt: Number(m.confirmedAt), confirmed: m.confirmed, state: Number(m.state), amount: amt };
    });
    return {
      id: Number(e.id), customer: e.customer, contractor: e.contractor, title: e.title,
      pool, distributed: e.distributed, relAmt: e.relAmt, penAmt: e.penAmt,
      penaltyBps: Number(e.penaltyBps), n: Number(e.n), resolved: Number(e.resolved),
      status: Number(e.status), customerFunded: e.customerFunded, contractorFunded: e.contractorFunded,
      createdAt: Number(e.createdAt), milestones,
    };
  } catch { return null; }
}

export async function fetchStats(contract?: ethers.Contract): Promise<Stats> {
  const c = contract ?? readContract();
  const [escrows, pool, released, penalized] = await Promise.all([c.escrowCount(), c.totalPool(), c.totalReleased(), c.totalPenalized()]);
  return { escrows: Number(escrows), pool, released, penalized };
}

export async function fetchFeed(count: number, contract?: ethers.Contract): Promise<Escrow[]> {
  const c = contract ?? readContract();
  const total = Number(await c.escrowCount());
  if (total === 0) return [];
  const ids: number[] = [];
  for (let i = total; i >= 1 && ids.length < count; i--) ids.push(i);
  const out = await mapLimit(ids, 6, (id) => fetchEscrow(id, c));
  return out.filter((x): x is Escrow => !!x).sort((a, b) => b.id - a.id);
}

export async function fetchEscrowsOf(addr: string, contract?: ethers.Contract): Promise<Escrow[]> {
  const c = contract ?? readContract();
  const [asC, asK]: [bigint[], bigint[]] = await Promise.all([c.escrowsOfCustomer(addr), c.escrowsOfContractor(addr)]);
  const ids = Array.from(new Set([...asC, ...asK].map(Number))).slice(-MAX);
  const out = await mapLimit(ids, 6, (id) => fetchEscrow(id, c));
  return out.filter((x): x is Escrow => !!x).sort((a, b) => b.id - a.id);
}

export async function fetchClaimable(addr: string, contract?: ethers.Contract): Promise<bigint> {
  const c = contract ?? readContract();
  return await c.claimable(addr);
}

// ── helpers ──────────────────────────────────────────────────
export function shortAddr(a: string, lead = 6, tail = 4): string { return a ? `${a.slice(0, lead)}…${a.slice(-tail)}` : ""; }

export function fmtUsdc(wei: bigint, dp = 2): string {
  const n = parseFloat(ethers.formatEther(wei));
  if (n === 0) return "0";
  if (n < 0.01) { const s = n.toFixed(4).replace(/0+$/, "").replace(/\.$/, ""); return s === "0" ? "<0.01" : s; }
  const s = n.toFixed(dp);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/** Milestone visual state given the live clock (now in seconds). */
export function msState(m: Milestone, now: number): "released" | "penalized" | "due" | "pending" {
  if (m.state === M_RELEASED) return "released";
  if (m.state === M_PENALIZED) return "penalized";
  if (now > 0 && now > m.deadline) return "due"; // past deadline, unresolved → validator should act (red)
  return "pending";
}

export function statusLabel(s: number): string {
  return s === PENDING ? "awaiting funding" : s === ACTIVE ? "active" : s === DONE ? "settled" : "cancelled";
}

export function timeLeft(deadline: number, now: number): string {
  if (now <= 0) return "…";
  let diff = deadline - now;
  if (diff <= 0) return "overdue";
  const d = Math.floor(diff / 86400); diff -= d * 86400;
  const h = Math.floor(diff / 3600); diff -= h * 3600;
  const m = Math.floor(diff / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  const s = diff - m * 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
