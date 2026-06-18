// MilestoneStake VALIDATOR agent — the permissionless deadline keeper.
// Watches active escrows; resolves the current milestone the moment it's confirmed OR its
// deadline passes (releaseOrPenalize). Holds no special power — anyone can run this; if it's
// down, either party can resolve. Run: AGENT_PRIVATE_KEY=0x.. CONTRACT=0x.. node agent/validator.mjs
import { JsonRpcProvider, Wallet, Contract } from "ethers";

const RPC = process.env.ARC_RPC || "https://rpc.testnet.arc.network";
const CONTRACT = process.env.CONTRACT, PK = process.env.AGENT_PRIVATE_KEY;
const POLL = Number(process.env.POLL_MS || 30000);
if (!CONTRACT || !PK) { console.error("set CONTRACT and AGENT_PRIVATE_KEY"); process.exit(1); }

const ABI = [
  "function escrowCount() view returns (uint256)",
  "function getEscrow(uint256) view returns (tuple(uint256 id,address customer,address contractor,string title,uint256 customerStake,uint256 contractorStake,uint256 pool,uint256 distributed,uint256 relAmt,uint256 penAmt,uint16 penaltyBps,uint8 n,uint8 resolved,uint8 status,bool customerFunded,bool contractorFunded,uint64 createdAt))",
  "function milestonesOf(uint256) view returns (tuple(uint16 weightBps,uint64 deadline,uint64 confirmedAt,bool confirmed,uint8 state)[])",
  "function releaseOrPenalize(uint256 id, uint8 i)",
];
const wallet = new Wallet(PK, new JsonRpcProvider(RPC, 5042002));
const c = new Contract(CONTRACT, ABI, wallet);
console.log(`MilestoneStake validator · ${wallet.address} · ${CONTRACT}`);

async function tick() {
  try {
    const n = Number(await c.escrowCount());
    const now = Math.floor(Date.now() / 1000);
    for (let id = 1; id <= n; id++) {
      const e = await c.getEscrow(id);
      if (Number(e.status) !== 1) continue; // ACTIVE only
      const ms = await c.milestonesOf(id);
      const i = Number(e.resolved);
      const m = ms[i];
      if (!m || Number(m.state) !== 0) continue;
      const due = m.confirmed || now > Number(m.deadline);
      if (!due) continue;
      process.stdout.write(`escrow ${id} "${e.title}" → resolving milestone ${i + 1}… `);
      try { const tx = await c.releaseOrPenalize(id, i); await tx.wait(); console.log("✓", tx.hash); }
      catch (err) { console.log("skip:", err.shortMessage || err.message); }
    }
  } catch (err) { console.error("tick error:", err.message); }
}
await tick();
setInterval(tick, POLL);
