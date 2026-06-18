// EIP-6963 multi-wallet discovery.

export interface Eip1193Provider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
  isRabby?: boolean;
  isMetaMask?: boolean;
}

interface ProviderDetail {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: Eip1193Provider;
}

const discovered: ProviderDetail[] = [];
const RDNS_KEY = "milestonestake.wallet";
const PREFERENCE = ["io.rabby", "io.metamask"];

function record(detail?: ProviderDetail) {
  if (!detail?.info?.rdns || !detail.provider) return;
  const i = discovered.findIndex((d) => d.info.rdns === detail.info.rdns);
  if (i === -1) discovered.push(detail);
  else discovered[i] = detail;
}

if (typeof window !== "undefined") {
  window.addEventListener("eip6963:announceProvider", (e: Event) => {
    record((e as CustomEvent<ProviderDetail>).detail);
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

export function getChosenRdns(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(RDNS_KEY) || "";
  } catch {
    return "";
  }
}

export function setChosenRdns(rdns: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RDNS_KEY, rdns);
  } catch {
    /* ignore */
  }
}

export function ensureDiscovered(timeoutMs = 250): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (discovered.length) {
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      resolve();
    };
    const onAnnounce = () => finish();
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    setTimeout(finish, timeoutMs);
  });
}

export function refreshWallets() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("eip6963:requestProvider"));
}

export function listWallets() {
  refreshWallets();
  return discovered.map((d) => ({ name: d.info.name, rdns: d.info.rdns, icon: d.info.icon }));
}

export function pickDetail(rdns?: string): { provider: Eip1193Provider; rdns: string } | undefined {
  refreshWallets();
  const want = rdns ?? getChosenRdns();
  if (want) {
    const m = discovered.find((d) => d.info.rdns === want);
    if (m) return { provider: m.provider, rdns: m.info.rdns };
  }
  for (const r of PREFERENCE) {
    const m = discovered.find((d) => d.info.rdns === r);
    if (m) return { provider: m.provider, rdns: m.info.rdns };
  }
  if (discovered[0]) return { provider: discovered[0].provider, rdns: discovered[0].info.rdns };
  return undefined;
}

export function pickProvider(rdns?: string): Eip1193Provider | undefined {
  const d = pickDetail(rdns);
  if (d) return d.provider;
  return typeof window !== "undefined" ? (window.ethereum as Eip1193Provider | undefined) : undefined;
}



