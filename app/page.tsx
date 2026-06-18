"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { ethers } from "ethers";
import PixelFlower from "@/components/PixelFlower";
import { useWallet } from "@/lib/useWallet";
import { ARCSCAN, switchToArc } from "@/lib/arcNetwork";
import { pickProvider } from "@/lib/wallet";
import {
  CONTRACT_ADDRESS, MILESTONESTAKE_ABI, hasContract, readContract,
  fetchStats, fetchFeed, fetchEscrow, fetchClaimable,
  fmtUsdc, shortAddr, msState, statusLabel, timeLeft,
  PENDING, ACTIVE, DONE, M_OPEN,
  type Escrow, type Stats, EMPTY_STATS,
} from "@/lib/milestonestake";

const POOL_CHIPS = ["2", "5", "10"];
const DECO = [
  { x: "8%", y: "16%", s: "released" }, { x: "84%", y: "20%", s: "penalized" }, { x: "12%", y: "70%", s: "pending" },
  { x: "78%", y: "64%", s: "released" }, { x: "46%", y: "12%", s: "pending" }, { x: "60%", y: "78%", s: "penalized" },
] as const;

export default function Home() {
  const { account, balance, chainOk, connecting, connect, disconnect, refreshBalance } = useWallet();
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);
  const [feed, setFeed] = useState<Escrow[]>([]);
  const [sel, setSel] = useState<Escrow | null>(null);
  const [claimable, setClaimable] = useState<bigint>(0n);
  const [now, setNow] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  const [walletOpen, setWalletOpen] = useState(false);
  const [bloomIdx, setBloomIdx] = useState(-1);

  // create form
  const [open, setOpen] = useState(false);
  const [fContractor, setFContractor] = useState("");
  const [fTitle, setFTitle] = useState("");
  const [fPool, setFPool] = useState("5");
  const [fPenalty, setFPenalty] = useState("20");
  const [fN, setFN] = useState("4");
  const [fCadence, setFCadence] = useState("14");

  const epoch = useRef(0);
  const accountRef = useRef(account);
  const inFlight = useRef(false);
  useEffect(() => { accountRef.current = account; }, [account]);
  useEffect(() => { setNow(Math.floor(Date.now() / 1000)); const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000); return () => clearInterval(t); }, []);

  const load = useCallback(async () => {
    if (!hasContract()) return;
    const e = ++epoch.current;
    try {
      const c = readContract();
      const [s, f] = await Promise.all([fetchStats(c), fetchFeed(24, c)]);
      if (e !== epoch.current) return;
      setStats(s); setFeed(f);
      setSel((cur) => (cur ? f.find((x) => x.id === cur.id) ?? cur : f[0] ?? null));
      if (account) { const cl = await fetchClaimable(account, c); if (e === epoch.current) setClaimable(cl); } else setClaimable(0n);
    } catch { /* keep */ }
  }, [account]);
  useEffect(() => { load(); }, [load]);

  async function refreshSel(id: number) { const fr = await fetchEscrow(id); if (fr) setSel(fr); }
  async function writeC() {
    const inj = pickProvider(); if (!inj) throw new Error("No wallet found");
    await switchToArc(inj);
    const signer = await new ethers.BrowserProvider(inj).getSigner(account);
    return new ethers.Contract(CONTRACT_ADDRESS, MILESTONESTAKE_ABI, signer);
  }
  function reason(e: unknown): string {
    const err = e as { code?: string | number; reason?: string; shortMessage?: string; message?: string };
    if (err?.code === "ACTION_REJECTED" || err?.code === 4001) return "Cancelled";
    return (err?.reason || err?.shortMessage || err?.message || "Failed").slice(0, 90);
  }
  function flash(t: string) { setToast(t); setTimeout(() => setToast(""), 3600); }
  async function run(key: string, fn: (c: ethers.Contract) => Promise<ethers.ContractTransactionResponse>, done: string): Promise<boolean> {
    if (!account) { if (!pickProvider()) { flash("✗ no wallet — install Rabby or MetaMask"); return false; } connect(); return false; }
    if (inFlight.current) return false;
    inFlight.current = true; const cap = account; setBusy(key); flash("confirm in your wallet…");
    let ok = false;
    try { const c = await writeC(); const tx = await fn(c); flash("settling on ARC…"); await tx.wait(); if (accountRef.current !== cap) return false; flash(done); await load(); if (sel) await refreshSel(sel.id); await refreshBalance(cap); ok = true; }
    catch (e) { flash("✗ " + reason(e)); } finally { inFlight.current = false; setBusy(null); }
    return ok;
  }

  const doFund = (e: Escrow) => run("fund", (c) => c.fund(e.id, { value: e.pool }), `✓ funded — ${fmtUsdc(e.pool)} USDC escrowed`);
  const doConfirm = (e: Escrow) => run("confirm", (c) => c.confirmMilestone(e.id, e.resolved), `✓ milestone ${e.resolved + 1} confirmed`);
  const doResolve = (e: Escrow) => { setBloomIdx(e.resolved); return run("resolve", (c) => c.releaseOrPenalize(e.id, e.resolved), "✓ milestone resolved — USDC routed"); };
  const doClaim = () => run("claim", (c) => c.claim(), "✓ claimed to your wallet");
  const doCancel = (e: Escrow) => run("cancel", (c) => c.cancel(e.id), "✓ escrow cancelled — refunded");
  async function doCreate() {
    const t = fTitle.trim();
    if (!ethers.isAddress(fContractor)) return flash("✗ contractor wallet address?");
    if (account && fContractor.toLowerCase() === account.toLowerCase()) return flash("✗ contractor can't be you");
    if (!t) return flash("✗ name the project");
    const pool = Number(fPool); if (!(pool > 0)) return flash("✗ pool amount?");
    const n = Number(fN); if (!Number.isInteger(n) || n < 2 || n > 6) return flash("✗ 2–6 milestones");
    const pen = Math.round(Number(fPenalty) * 100); if (!(pen >= 0 && pen <= 5000)) return flash("✗ penalty 0–50%");
    const cad = Number(fCadence); if (!(cad >= 1)) return flash("✗ cadence days?");
    const w = Math.floor(10000 / n); const weights = Array.from({ length: n }, (_, i) => (i === n - 1 ? 10000 - w * (n - 1) : w));
    const base = Math.floor(Date.now() / 1000);
    const deadlines = Array.from({ length: n }, (_, i) => base + (i + 1) * cad * 86400);
    const poolWei = ethers.parseEther(fPool);
    const ok = await run("create", (c) => c.createEscrow(fContractor, t, poolWei, 0, pen, weights, deadlines), "✓ escrow created — fund it to activate");
    if (ok) { setOpen(false); setFTitle(""); setFContractor(""); try { const fr = await fetchFeed(1, readContract()); if (fr[0]) setSel(fr[0]); } catch { /* keep */ } }
  }

  const isCustomer = !!(sel && account && sel.customer.toLowerCase() === account.toLowerCase());
  const maxAmt = sel ? sel.milestones.reduce((a, m) => (m.amount > a ? m.amount : a), 1n) : 1n;
  const list = feed;
  const title = sel ? sel.title : "MilestoneStake";

  // contextual primary action for the selected escrow
  let action: React.ReactNode = null;
  if (sel) {
    const cur = sel.milestones[sel.resolved];
    const dueOrConfirmed = cur && (cur.confirmed || (now > 0 && now > cur.deadline));
    if (sel.status === PENDING && isCustomer && !sel.customerFunded) action = <button onClick={() => doFund(sel)} disabled={!!busy} className="btn btn--paper">{busy === "fund" ? "funding…" : `fund pool · ${fmtUsdc(sel.pool)} USDC`}</button>;
    else if (sel.status === PENDING) action = <button onClick={() => doCancel(sel)} disabled={!!busy} className="btn btn--ghost btn--sm">{busy === "cancel" ? "…" : "cancel"}</button>;
    else if (sel.status === ACTIVE && cur && cur.state === M_OPEN && isCustomer && !cur.confirmed) action = <button onClick={() => doConfirm(sel)} disabled={!!busy} className="btn btn--green">{busy === "confirm" ? "confirming…" : `confirm milestone ${sel.resolved + 1}`}</button>;
    else if (sel.status === ACTIVE && cur && cur.state === M_OPEN && dueOrConfirmed) action = <button onClick={() => doResolve(sel)} disabled={!!busy} className="btn btn--paper">{busy === "resolve" ? "resolving…" : `release milestone ${sel.resolved + 1}`}</button>;
    else if (sel.status === ACTIVE && cur && cur.state === M_OPEN && isCustomer) action = <span className="lbl">waiting on milestone {sel.resolved + 1}</span>;
  }

  return (
    <div style={{ minHeight: "100vh", paddingBottom: 80 }}>
      <div className="wrap">
        <nav className="nav">
          <button onClick={() => setSel(null)} style={{ display: "flex", alignItems: "center", gap: 11, background: "none", border: "none" }}>
            <span className="sway" style={{ display: "inline-flex" }}><PixelFlower state="released" size={30} /></span>
            <span className="mono" style={{ fontSize: 14, letterSpacing: "0.1em" }}>MILESTONESTAKE</span>
          </button>
          <div style={{ display: "flex", alignItems: "center", gap: "clamp(14px,2.5vw,30px)", flexWrap: "wrap" }}>
            <a href="#works" className="nav-link">Escrows</a>
            <a href="#how" className="nav-link">How</a>
            <button onClick={() => setOpen(true)} className="nav-link" style={{ background: "none", border: "none" }}>+ New</button>
            {account ? (
              <div style={{ position: "relative" }}>
                <button onClick={() => setWalletOpen((o) => !o)} className="btn btn--ghost btn--sm"><span style={{ width: 7, height: 7, borderRadius: 99, background: chainOk ? "var(--green)" : "var(--red)" }} /> {shortAddr(account, 4, 4)}</button>
                {walletOpen && (<>
                  <div onClick={() => setWalletOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 60 }} />
                  <div className="card" style={{ position: "absolute", top: "calc(100% + 8px)", right: 0, zIndex: 61, minWidth: 220, overflow: "hidden" }}>
                    <div style={{ padding: "13px 15px" }}><div className="lbl">wallet</div><div className="mono" style={{ fontSize: 13, marginTop: 5 }}>{shortAddr(account, 9, 6)}</div><div className="mono green-t" style={{ fontSize: 12, marginTop: 5 }}>{balance || "0"} USDC</div></div>
                    {!chainOk && <button className="menu-item red-t" onClick={() => switchToArc().catch(() => {})}>switch to ARC</button>}
                    {claimable > 0n && <button className="menu-item green-t" onClick={() => { setWalletOpen(false); doClaim(); }}>claim {fmtUsdc(claimable)} USDC</button>}
                    <a className="menu-item" href={`${ARCSCAN}/address/${account}`} target="_blank" rel="noopener noreferrer">arcscan ↗</a>
                    <button className="menu-item" onClick={() => { setWalletOpen(false); disconnect(); }}>disconnect</button>
                  </div>
                </>)}
              </div>
            ) : <button onClick={connect} disabled={connecting} className="btn btn--paper btn--sm">{connecting ? "…" : "connect"}</button>}
          </div>
        </nav>
      </div>

      {/* ── hero ── */}
      <section className="wrap" style={{ position: "relative", paddingTop: "clamp(20px,4vw,40px)", paddingBottom: 20 }}>
        {DECO.map((d, i) => <span key={i} className="deco sway" style={{ left: d.x, top: d.y, animationDelay: `${i * 0.4}s` }}><PixelFlower state={d.s} size={26} /></span>)}
        <div style={{ position: "relative", textAlign: "center", padding: "clamp(20px,5vw,60px) 0" }}>
          <div className="lbl" style={{ marginBottom: 18 }}>{sel ? `escrow #${sel.id < 10 ? "0" + sel.id : sel.id} · ${statusLabel(sel.status)}` : "milestone escrow · arc testnet"}</div>
          <h1 className="serif" style={{ fontSize: "clamp(48px,11vw,150px)", lineHeight: 0.95, color: "var(--paper)" }}>{title}</h1>
          {sel ? (
            <div style={{ display: "flex", gap: "clamp(16px,4vw,46px)", justifyContent: "center", flexWrap: "wrap", marginTop: 22 }}>
              <span className="lbl">customer · {shortAddr(sel.customer, 4, 4)}{isCustomer ? " (you)" : ""}</span>
              <span className="lbl">contractor · {shortAddr(sel.contractor, 4, 4)}</span>
              <span className="lbl"><span className="num green-t" style={{ fontSize: 16 }}>{fmtUsdc(sel.pool)}</span> USDC pool</span>
              <span className="lbl">{sel.penaltyBps / 100}% late penalty</span>
            </div>
          ) : (
            <p style={{ maxWidth: 540, margin: "22px auto 0", color: "var(--paper-dim)", fontSize: 17, lineHeight: 1.5 }}>Fund a USDC pool against milestones. Each one your client confirms blooms a flower and releases its share — late ones pay a penalty back. Settled on ARC by agents, no custody.</p>
          )}
          <div style={{ display: "flex", gap: 12, justifyContent: "center", marginTop: 30, flexWrap: "wrap" }}>
            {action}
            {!sel && <button onClick={() => setOpen(true)} className="btn btn--paper">open an escrow</button>}
            {!sel && <a href="#works" className="btn btn--ghost">↓ escrows</a>}
          </div>
        </div>

        {/* milestone garden */}
        {sel && (
          <div className="card" style={{ padding: "clamp(20px,3vw,34px)", marginTop: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 22, flexWrap: "wrap", gap: 10 }}>
              <span className="lbl">↓ the milestone garden · {sel.resolved}/{sel.n} released</span>
              {claimable > 0n && account && <button onClick={doClaim} disabled={!!busy} className="btn btn--green btn--sm">{busy === "claim" ? "…" : `claim ${fmtUsdc(claimable)} USDC`}</button>}
            </div>
            <div className="garden">
              {sel.milestones.map((m, i) => {
                const st = msState(m, now);
                const h = 40 + Number((m.amount * 140n) / maxAmt);
                const isCurrent = i === sel.resolved && sel.status === ACTIVE;
                return (
                  <div key={i} className="stem-wrap">
                    <div className={`bfloom${st === "released" && i === bloomIdx ? " bloomed glow" : ""}${isCurrent ? " sway" : ""}`}>
                      <PixelFlower state={st} size={isCurrent ? 44 : 36} />
                    </div>
                    <div className={`stem${st === "released" ? "" : " stem--pending"}`} style={{ height: h, background: st === "penalized" ? "linear-gradient(rgba(255,87,87,.6),rgba(255,87,87,.2))" : undefined }} />
                    <div className="flower-cap">
                      <div className="lbl" style={{ fontSize: 9 }}>M{i + 1}</div>
                      <div className="mono" style={{ fontSize: 11, color: st === "released" ? "var(--green)" : st === "penalized" ? "var(--red)" : "var(--paper)" }}>${fmtUsdc(m.amount)}</div>
                      <div className="lbl" style={{ fontSize: 8.5, marginTop: 2 }}>{st === "released" ? "released" : st === "penalized" ? "penalized" : st === "due" ? "overdue" : timeLeft(m.deadline, now)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
            {/* auditor ticker */}
            <div className="mono" style={{ fontSize: 12, color: "var(--mono-ink)", marginTop: 16, display: "flex", gap: "clamp(10px,3vw,26px)", flexWrap: "wrap", justifyContent: "center" }}>
              <span>AUDITOR ▸ POOL {fmtUsdc(sel.pool)}</span>
              <span className="green-t">{fmtUsdc(sel.relAmt)} released</span>
              <span className="red-t">{fmtUsdc(sel.penAmt)} penalty→customer</span>
              <span>{fmtUsdc(sel.pool - sel.distributed)} remaining</span>
              <span style={{ opacity: 0.7 }}>· VALIDATOR watching deadlines</span>
            </div>
          </div>
        )}
      </section>

      {/* ── works grid ── */}
      <section id="works" className="wrap" style={{ marginTop: "clamp(40px,6vw,80px)" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 22, flexWrap: "wrap", gap: 12 }}>
          <h2 className="serif" style={{ fontSize: "clamp(30px,5vw,52px)" }}>escrows</h2>
          <span className="lbl">{stats.escrows} opened · <span className="green-t">{fmtUsdc(stats.released)}</span> released · {fmtUsdc(stats.pool)} pooled</span>
        </div>
        {!hasContract() ? (
          <div className="card" style={{ padding: 40, textAlign: "center", color: "var(--paper-dim)" }}>contract not deployed — deploy at <a href="/deploy" style={{ textDecoration: "underline" }}>/deploy</a></div>
        ) : list.length === 0 ? (
          <div className="card" style={{ padding: 50, textAlign: "center", color: "var(--paper-dim)" }}>no escrows yet — open the first one.</div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px,1fr))", gap: 16 }}>
            {list.map((e) => (
              <div key={e.id} className="card card--hover" style={{ padding: 18 }} onClick={() => { setSel(e); window.scrollTo({ top: 0, behavior: "smooth" }); }}>
                <div style={{ display: "flex", gap: 5, marginBottom: 12 }}>{e.milestones.map((m, i) => <PixelFlower key={i} state={msState(m, now)} size={20} />)}</div>
                <div className="serif" style={{ fontSize: 24, lineHeight: 1, marginBottom: 10, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.title}</div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span className="num green-t" style={{ fontSize: 18 }}>${fmtUsdc(e.pool)}</span>
                  <span className="lbl" style={{ alignSelf: "center" }}>{e.resolved}/{e.n} · {statusLabel(e.status)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── how ── */}
      <section id="how" className="wrap" style={{ marginTop: "clamp(48px,7vw,90px)" }}>
        <h2 className="serif" style={{ fontSize: "clamp(28px,4.4vw,46px)", maxWidth: 760, marginBottom: 18 }}>Why it can only bloom on Arc</h2>
        <p style={{ maxWidth: 720, color: "var(--paper-dim)", fontSize: 16.5, lineHeight: 1.6 }}>
          A $5 pool over 5 milestones is <b className="green-t">$1 each</b>; a 20% late penalty is a <b className="red-t">$0.20</b> split. Where gas is a separate volatile token, paying a swinging fee to move a fixed dollar is incoherent, and an autonomous validator that flags a late $1 milestone would burn more gas than it moves. On <b style={{ color: "var(--paper)" }}>ARC, USDC is the gas and the money</b> — a confirm costs cents of the same dollar it releases, micro-penalty splits net positive, and always-on validator + auditor agents are profitable to run. Sub-second finality makes confirm→release feel synchronous. The pool sits in the contract, never a platform — neither party trusts MilestoneStake with a cent.
        </p>
        <div className="lbl" style={{ marginTop: 26, display: "flex", gap: "clamp(14px,4vw,40px)", flexWrap: "wrap" }}>
          <span>settled on ARC</span><span>· native USDC</span><span>· no custody</span><span>· validator + auditor agents</span>
          {hasContract() && <a href={`${ARCSCAN}/address/${CONTRACT_ADDRESS}`} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "underline" }}>contract {shortAddr(CONTRACT_ADDRESS, 6, 4)} ↗</a>}
        </div>
      </section>

      {/* create modal */}
      {open && (
        <div className="scrim" onClick={() => setOpen(false)}>
          <div className="modal rise" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
              <h2 className="serif" style={{ fontSize: 34 }}>new escrow</h2>
              <button onClick={() => setOpen(false)} className="btn btn--ghost btn--sm">✕</button>
            </div>
            <div className="lbl" style={{ marginBottom: 7 }}>project title</div>
            <input value={fTitle} onChange={(e) => setFTitle(e.target.value)} maxLength={80} className="input" placeholder="Atelier rebrand" />
            <div className="lbl" style={{ margin: "16px 0 7px" }}>contractor wallet (the worker — gets paid)</div>
            <input value={fContractor} onChange={(e) => setFContractor(e.target.value)} className="input mono" placeholder="0x… contractor address" />
            <div style={{ display: "flex", gap: 12, marginTop: 16, flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 130 }}>
                <div className="lbl" style={{ marginBottom: 7 }}>pool (USDC)</div>
                <div style={{ display: "flex", gap: 6 }}>{POOL_CHIPS.map((c) => <button key={c} className="chip" data-on={fPool === c} onClick={() => setFPool(c)}>${c}</button>)}</div>
              </div>
              <div style={{ width: 110 }}>
                <div className="lbl" style={{ marginBottom: 7 }}>milestones</div>
                <input value={fN} onChange={(e) => setFN(e.target.value)} inputMode="numeric" className="input mono" placeholder="4" />
              </div>
            </div>
            <div style={{ display: "flex", gap: 12, marginTop: 16, flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 130 }}>
                <div className="lbl" style={{ marginBottom: 7 }}>late penalty %</div>
                <input value={fPenalty} onChange={(e) => setFPenalty(e.target.value)} inputMode="decimal" className="input mono" placeholder="20" />
              </div>
              <div style={{ flex: 1, minWidth: 130 }}>
                <div className="lbl" style={{ marginBottom: 7 }}>days / milestone</div>
                <input value={fCadence} onChange={(e) => setFCadence(e.target.value)} inputMode="numeric" className="input mono" placeholder="14" />
              </div>
            </div>
            <p className="mono" style={{ fontSize: 11, color: "var(--mono-ink)", marginTop: 14, lineHeight: 1.5 }}>You (customer) fund the whole pool. Milestones get equal shares + evenly-spaced deadlines. Confirm each as it&apos;s delivered; on-time releases its share to the contractor, late ones send {fPenalty || "0"}% back to you.</p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 20 }}>
              <button onClick={() => setOpen(false)} className="btn btn--ghost">cancel</button>
              <button onClick={doCreate} disabled={busy === "create"} className="btn btn--paper">{busy === "create" ? "creating…" : "create escrow"}</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast rise" style={{ color: toast.startsWith("✓") ? "var(--green)" : toast.startsWith("✗") ? "var(--red)" : "var(--paper)" }}>{toast}</div>}
    </div>
  );
}
