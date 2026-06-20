# Project Charter — MilestoneStake

> A control document for fixed-scope contractor engagements settled milestone-by-milestone on-chain.
> Live instance: https://milestonestake-arc.vercel.app/

| Field | Entry |
|---|---|
| **Document** | Engagement charter, single-pool variant |
| **Scope** | One customer engages one named contractor for a fixed deliverable, divided into 2–6 (contract allows up to 24) milestones, each carrying a weight share of a single prepaid pool and a hard calendar deadline. |
| **Parties** | **Customer** — funds the pool, attests delivery. **Contractor** — performs the work, draws each released share. No third signatory. |
| **Pool** | One prepayment of native USDC, **$2–$10** in the live UI, deposited in full before any work begins. Held by contract `0xfdB517E4deE1c17cA39196C7fB291D064C1F2CB0`. The contract is neither party and takes no cut. |
| **Settlement venue** | Arc testnet, chain `5042002`. Ledger of record: https://testnet.arcscan.app/address/0xfdB517E4deE1c17cA39196C7fB291D064C1F2CB0 |

---

## 1. Statement of intent

Fixed-bid project work fails at the same seam every time: the customer wants proof before paying, the contractor wants assurance before working, and neither trusts the other to hold the float. This charter resolves that by escrowing the entire budget up front and metering it out one milestone at a time, on terms that no party can alter after signing. Money already in the contract is the contractor's assurance; the customer's protection is that each slice releases only on attested, on-time delivery — and that lateness costs the contractor automatically.

The arrangement is deliberately single-sided. The customer prepays the whole pool (`createEscrow` is invoked with `contractorStake = 0`); the contractor posts nothing. This is a budget-disbursement instrument, not a mutual wager.

## 2. Milestone register

A milestone is created with a weight in basis points and a calendar deadline. The register below is illustrative — a four-milestone, $5.00 pool at the UI default of equal weights and a 14-day cadence. Weights are assigned `floor(10000 / n)` each, with the final milestone absorbing the remainder so the shares sum to the pool to the cent (`shareOf` and the client both reconstruct this dust rule).

| Milestone | Weight | Share of $5.00 pool | Deadline | State |
|---|---|---|---|---|
| M1 | 2500 bps | $1.25 | day 14 | OPEN → RELEASED / PENALIZED |
| M2 | 2500 bps | $1.25 | day 28 | OPEN |
| M3 | 2500 bps | $1.25 | day 42 | OPEN |
| M4 | 2500 bps | $1.25 | day 56 | OPEN |

Register rules enforced at `createEscrow`:

- Weights must total exactly **10000 bps (100%)**; each weight is in `[1, 10000]`.
- Deadlines must be **strictly increasing** and each strictly in the future.
- Milestone count is `[1, 24]` on-chain (the live form offers 2–6).
- The named contractor cannot be the customer; the title is 1–80 characters.

Milestones resolve **strictly in sequence**. The pointer `resolved` names the only milestone currently actionable; M2 cannot be touched until M1 has left the OPEN state.

## 3. Release logic

Disbursement runs in two recorded steps, never one:

1. **Attestation — `confirmMilestone(id, i)`.** Only the customer may call it, only on the current milestone, only while the escrow is ACTIVE. It moves no money; it stamps `confirmed = true` and records `confirmedAt`. Confirmation is a signature on the timeline, judged later.

2. **Resolution — `releaseOrPenalize(id, i)`.** Permissionless: any address may call it once the milestone is either confirmed or past deadline. It reads the timestamps and routes the share exactly one of three ways:

| Condition at resolution | Outcome | Bookkeeping |
|---|---|---|
| Confirmed, `confirmedAt ≤ deadline` | Full share → contractor | state = RELEASED |
| Confirmed, but `confirmedAt > deadline` | Penalty slice → customer; remainder → contractor | state = PENALIZED |
| Never confirmed, deadline passed | Whole share refunded → customer | state = PENALIZED |

Payouts are **pull-based**. Resolution credits an internal `claimable` ledger; recipients later withdraw everything owed across all their engagements with a single `claim()`. A contractor whose wallet reverts can therefore never freeze a resolution, and the contract follows checks-effects-interactions with the one external transfer placed after state is zeroed.

Funding is its own gate: `fund(id)` activates the escrow only once the required side(s) are in; before activation either party may `cancel(id)` and have their deposit returned to the claim ledger, so a no-show counterparty cannot strand funds.

## 4. Delay penalty

Lateness is priced, not litigated. Each engagement fixes a `penaltyBps` at creation (UI default **20%**, hard-capped on-chain at **5000 bps / 50%**). When a milestone is delivered late, resolution computes `toCustomer = share * penaltyBps / 10000` and pays the contractor only `share − toCustomer`. The penalty is not a fine paid to a platform — it is rebated to the customer as delay insurance, milestone by milestone. A never-delivered milestone is the limiting case: the full share returns to the customer.

Worked example on the register above, 20% penalty: an on-time M1 pays the contractor **$1.25**; an M1 delivered after day 14 pays the contractor **$1.00** and rebates **$0.25** to the customer; an abandoned M1 returns the whole **$1.25**.

This is where the venue stops being incidental. The unit of account here is a sub-dollar slice and the unit of correction is a **twenty-cent rebate**. An instrument that must split twenty-five cents into a dollar payout and a quarter refund — and do it on a fixed calendar date — is only sane where the cost to execute that split is itself measured in cents of the same currency, and where finality is fast enough that confirm and release feel like one motion. Arc settles native USDC at that granularity: the fee to resolve a milestone is a few cents of the dollar being moved, not a wager on a separate volatile fee token whose price could swallow the rebate it's meant to deliver. A penalty mechanism that costs more to apply than the penalty itself is not a mechanism; metering a $5 budget into four $1.25 slices with cent-scale corrections is the specific thing that only adds up when settlement is this cheap.

## 5. Governance (validator & auditor)

There is no administrator. The contract has no owner, no fee switch, and no upgrade path; the customer and contractor (plus the permissionless deadline mechanic) are the only actors who can move value. Two off-chain helpers exist, both supplied as runnable scripts in [`agent/`](agent/) — **neither is a privileged or hosted service**, and the system is fully operable without them.

- **Validator** — [`agent/validator.mjs`](agent/validator.mjs). A local Node process (run with `AGENT_PRIVATE_KEY` and `CONTRACT` set) that polls every 30 s, finds each ACTIVE escrow's current milestone, and calls `releaseOrPenalize` the moment it is confirmed or its deadline crosses. It holds no special key relationship — it acts on the same permissionless entrypoint any party could call. If it is offline, the customer or contractor resolves manually (the live app exposes the same action as a button). It exists so deadline-driven refunds happen on time without anyone watching the clock.

- **Auditor** — [`agent/auditor.mjs`](agent/auditor.mjs). A read-only Node script. For each escrow it calls `report(id)` and prints `pool / released→contractor / penalty→customer / remaining`, then asserts the conservation invariant `released + penalty + remaining == pool`. It signs nothing and can change nothing; it is a reconciliation tool. The live page renders the same four figures as an on-page ticker.

## 6. On-chain ledger

| Attribute | Value |
|---|---|
| Contract | `MilestoneStake.sol`, Solidity `^0.8.20`, single file |
| Address | `0xfdB517E4deE1c17cA39196C7fB291D064C1F2CB0` |
| Network | Arc testnet, chain id `5042002` |
| Asset | native USDC (the chain's settlement currency) |
| Explorer | https://testnet.arcscan.app/address/0xfdB517E4deE1c17cA39196C7fB291D064C1F2CB0 |
| Custody | none — funds rest in the contract, withdrawn only by the credited party |

Mutating entrypoints: `createEscrow`, `fund`, `confirmMilestone`, `releaseOrPenalize`, `claim`, `cancel`.
Read surface: `getEscrow`, `milestonesOf`, `shareOf`, `report`, `claimable`, `escrowsOfCustomer`, `escrowsOfContractor`, and the aggregates `escrowCount` / `totalPool` / `totalReleased` / `totalPenalized`.

## 7. Operating the instance

```bash
npm install
npm run dev        # http://localhost:3000
```

The customer and contractor each act from their own wallet on chain 5042002. Resolution is permissionless: run the validator from any funded key, or click the in-app release control. Front end built with Next.js, React, ethers v6, and Tailwind against the deployed contract above.

---

*MilestoneStake — Albert Hughes. Pay for delivery, on the date, to the cent.*
