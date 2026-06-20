"use client";

import { ethers } from "ethers";
import { useCallback, useEffect, useRef, useState } from "react";
import { ensureDiscovered, pickDetail, pickProvider, setChosenRdns, type Eip1193Provider } from "./wallet";
import { ARC_CHAIN_HEX, ARC_RPC, switchToArc } from "./arcNetwork";

// Flag persisted when the user intentionally disconnects, so we don't
// silently re-attach on the next page load. Namespaced per build.
const STAY_DISCONNECTED = "ms-garden:v1:stay-disconnected";

const onArc = (chainId: string) => chainId.toLowerCase() === ARC_CHAIN_HEX.toLowerCase();

export function useWallet() {
  const [account, setAccount] = useState("");
  const [balance, setBalance] = useState("");
  const [chainOk, setChainOk] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const optedOut = useRef(false);
  const listeners = useRef<{ provider: Eip1193Provider; cleanup: () => void } | null>(null);

  const refreshBalance = useCallback(async (addr: string) => {
    try {
      const rpc = new ethers.JsonRpcProvider(ARC_RPC);
      const wei = await rpc.getBalance(addr);
      setBalance(parseFloat(ethers.formatEther(wei)).toFixed(3));
    } catch {
      setBalance("вЂ”");
    }
  }, []);

  const subscribe = useCallback(
    (inj: Eip1193Provider) => {
      if (!inj?.on) return;
      if (listeners.current?.provider === inj) return;
      listeners.current?.cleanup();

      const handleChain = (c: unknown) => setChainOk(onArc(c as string));
      const handleAccounts = (a: unknown) => {
        if (optedOut.current) return;
        const accs = a as string[];
        if (accs.length) {
          setAccount(accs[0]);
          refreshBalance(accs[0]);
        } else {
          setAccount("");
          setBalance("");
          setChainOk(false);
        }
      };

      inj.on("accountsChanged", handleAccounts);
      inj.on("chainChanged", handleChain);
      listeners.current = {
        provider: inj,
        cleanup: () => {
          inj.removeListener?.("accountsChanged", handleAccounts);
          inj.removeListener?.("chainChanged", handleChain);
        },
      };
    },
    [refreshBalance]
  );

  const disconnect = useCallback(() => {
    optedOut.current = true;
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(STAY_DISCONNECTED, "1");
      } catch {
        /* ignore */
      }
    }
    setAccount("");
    setBalance("");
    setChainOk(false);
  }, []);

  const connect = useCallback(async () => {
    optedOut.current = false;
    if (typeof window !== "undefined") {
      try {
        window.localStorage.removeItem(STAY_DISCONNECTED);
      } catch {
        /* ignore */
      }
    }
    await ensureDiscovered();
    const detail = pickDetail();
    const inj = detail?.provider;
    if (!inj) return;
    setChosenRdns(detail.rdns);
    setConnecting(true);
    try {
      const accs = (await inj.request({ method: "eth_requestAccounts" })) as string[];
      if (!accs?.length) return;
      setAccount(accs[0]);
      subscribe(inj);
      try {
        await switchToArc(inj);
      } catch {
        /* user declined the network switch */
      }
      try {
        const id = (await inj.request({ method: "eth_chainId" })) as string;
        setChainOk(onArc(id));
      } catch {
        setChainOk(false);
      }
      refreshBalance(accs[0]);
    } catch {
      /* user rejected */
    } finally {
      setConnecting(false);
    }
  }, [refreshBalance, subscribe]);

  // On mount: respect a prior opt-out, otherwise silently re-attach any
  // already-authorized account and wire up provider event listeners.
  useEffect(() => {
    if (typeof window !== "undefined" && window.localStorage.getItem(STAY_DISCONNECTED) === "1") {
      optedOut.current = true;
    }
    (async () => {
      await ensureDiscovered();
      const inj = pickProvider();
      if (!inj) return;
      if (!optedOut.current) {
        try {
          const accs = (await inj.request({ method: "eth_accounts" })) as string[];
          if (accs.length) {
            setAccount(accs[0]);
            refreshBalance(accs[0]);
            inj
              .request({ method: "eth_chainId" })
              .then((id) => setChainOk(onArc(id as string)))
              .catch(() => {});
          }
        } catch {
          /* ignore */
        }
      }
      subscribe(inj);
    })();
    return () => {
      listeners.current?.cleanup();
      listeners.current = null;
    };
  }, [refreshBalance, subscribe]);

  return { account, balance, chainOk, connecting, connect, disconnect, refreshBalance };
}
