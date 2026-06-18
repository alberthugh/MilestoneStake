// MilestoneStake AUDITOR agent — the read-only pool-allocation reporter.
// Holds no power: reads report(id) for every escrow and prints released / penalty / remaining.
// This is the same data the UI's auditor ticker shows. Run: CONTRACT=0x.. node agent/auditor.mjs [id]
import { JsonRpcProvider, Contract, formatEther } from "ethers";

const RPC = process.env.ARC_RPC || "https://rpc.testnet.arc.network";
const CONTRACT = process.env.CONTRACT;
if (!CONTRACT) { console.error("set CONTRACT"); process.exit(1); }

const ABI = [
  "function escrowCount() view returns (uint256)",
  "function getEscrow(uint256) view returns (tuple(uint256 id,address customer,address contractor,string title,uint256 customerStake,uint256 contractorStake,uint256 pool,uint256 distributed,uint256 relAmt,uint256 penAmt,uint16 penaltyBps,uint8 n,uint8 resolved,uint8 status,bool customerFunded,bool contractorFunded,uint64 createdAt))",
  "function report(uint256) view returns (uint256 pool, uint256 released, uint256 penalized, uint256 remaining)",
];
const c = new Contract(CONTRACT, ABI, new JsonRpcProvider(RPC, 5042002));
const f = (x) => "$" + (+formatEther(x)).toFixed(2);
const ST = ["awaiting-funding", "active", "settled", "cancelled"];

const one = process.argv[2];
const ids = one ? [Number(one)] : Array.from({ length: Number(await c.escrowCount()) }, (_, i) => i + 1);
console.log(`MilestoneStake auditor · ${CONTRACT}\n`);
for (const id of ids) {
  const e = await c.getEscrow(id);
  if (e.customer === "0x0000000000000000000000000000000000000000") continue;
  const r = await c.report(id);
  console.log(`#${id} "${e.title}" [${ST[Number(e.status)]}] · ${e.resolved}/${e.n} milestones`);
  console.log(`   pool ${f(r.pool)} = ${f(r.released)} released→contractor · ${f(r.penalized)} penalty→customer · ${f(r.remaining)} remaining`);
  const ok = r.released + r.penalized + r.remaining === r.pool;
  console.log(`   invariant released+penalty+remaining==pool: ${ok ? "✓" : "✗ MISMATCH"}\n`);
}
