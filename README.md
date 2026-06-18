<h1 align="center">MilestoneStake</h1>

<p align="center"><em>Escrow that blooms a milestone at a time.</em></p>

<p align="center">
  <a href="https://milestonestake-arc.vercel.app">Live app</a> ·
  <a href="https://testnet.arcscan.app/address/0xfdB517E4deE1c17cA39196C7fB291D064C1F2CB0">Contract on ArcScan</a> ·
  Native USDC on ARC testnet
</p>

---

## What it is

After 24 years managing engineering projects I know the one thing that keeps a project honest: hard checkpoints with money behind them. MilestoneStake is that, on-chain.

A **customer** opens an escrow with a named **contractor** and funds a single pool of **$2–10 USDC** against **N milestones** — each with a share of the pool and a hard deadline. As work is delivered, the customer **confirms** each milestone; then anyone (a validator agent) **resolves** it:

- delivered **on time** → that milestone's share is released to the contractor,
- delivered **late** → a bounded **penalty** of the share is redirected to the customer (delay insurance), the rest still goes to the contractor,
- **never delivered** past the deadline → the whole share refunds to the customer.

Every payout is **pull-based** and the pool sits in the contract — no platform, no admin, no fee, no custody. Only the two named parties (plus permissionless time-based settlement) ever move the money.

The site is a cobalt editorial portfolio whose **milestone garden** blooms one 8-bit pixel-flower per released milestone — green for released, yellow pending, red for a penalized one.

## Why it can only bloom on Arc

A $5 pool over 5 milestones is **$1 each**; a 20% late penalty is a **$0.20** split that must pay $0.80 to the contractor and refund $0.20 to the customer. On any chain where gas is a separate volatile token this breaks twice: paying a swinging fee to move a fixed dollar is incoherent, and an autonomous validator that flags a late $1 milestone and triggers a $0.20 split would burn more gas than it moves — the agent is economically impossible. **On Arc, USDC is the gas *and* the money**: a confirm costs cents of the same dollar it releases, micro-penalty splits net positive, and always-on validator + auditor agents are profitable to run. Sub-second finality makes confirm→release feel synchronous. This isn't "a dApp that uses USDC" — cent-scale penalty splits settled by always-on agents are non-viable anywhere gas isn't the dollar.

## The two agents

- **Validator** ([`agent/validator.mjs`](agent/validator.mjs)) — permissionless deadline keeper: resolves the current milestone the moment it's confirmed or its deadline passes. No special power; if it's down, either party can resolve.
- **Auditor** ([`agent/auditor.mjs`](agent/auditor.mjs)) — read-only: prints each escrow's released / penalty / remaining and checks the invariant `released + penalty + remaining == pool` (the same figures as the in-app ticker).

## The contract

[`MilestoneStake.sol`](contracts/MilestoneStake.sol) — one file, no owner/admin/fee/upgrade. Weights must sum to 100%, deadlines strictly increasing; the last milestone absorbs rounding dust so Σ shares == pool exactly. CEI throughout; `claim()` is the only external call (post-zeroing, reentrancy-proof). Two independent adversarial money-safety audits before deploy found **zero fund-safety issues**.

| | |
|---|---|
| **Network** | ARC testnet (chain `5042002`) |
| **Address** | [`0xfdB517E4deE1c17cA39196C7fB291D064C1F2CB0`](https://testnet.arcscan.app/address/0xfdB517E4deE1c17cA39196C7fB291D064C1F2CB0) |
| **Compiler** | 0.8.35, optimizer 200, viaIR — verified on ArcScan |

## Run it locally

```bash
npm install
npm run dev            # http://localhost:3000
```

The customer/contractor act from their own wallets; the validator's resolve is permissionless (`agent/validator.mjs` from any funded key, or the in-app button).

## Built with

Next.js 16 · React 19 · ethers v6 · Solidity 0.8.35 · Tailwind v4 — on ARC.

---

<p align="center"><sub>Hard checkpoints, real money, no custody.</sub></p>
