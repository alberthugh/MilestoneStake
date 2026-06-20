/*
 * Wallet provider plumbing.
 * Listens for EIP-6963 announcements, keeps a registry of injected
 * providers, and remembers which one the user last chose.
 */

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

// Storage key is assembled from a namespace + slot so it reads distinctly
// from sibling builds. Slot "chosen-rdns" holds the last picked wallet rdns.
const NS = "ms-garden";
const slot = (name: string) => `${NS}:v1:${name}`;
const CHOSEN_SLOT = slot("chosen-rdns");

// Order of fallback when the user has not pinned a specific wallet.
const PREFERENCE = ["io.rabby", "io.metamask"];

// Live registry of everything that has announced itself.
const registry: ProviderDetail[] = [];

function upsert(detail?: ProviderDetail) {
  if (!detail?.info?.rdns || !detail.provider) return;
  const at = registry.findIndex((d) => d.info.rdns === detail.info.rdns);
  if (at === -1) registry.push(detail);
  else registry[at] = detail;
}

// Kick off discovery as soon as this module is evaluated in the browser.
if (typeof window !== "undefined") {
  window.addEventListener("eip6963:announceProvider", (e: Event) => {
    upsert((e as CustomEvent<ProviderDetail>).detail);
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

export function refreshWallets() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("eip6963:requestProvider"));
}

export function setChosenRdns(rdns: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CHOSEN_SLOT, rdns);
  } catch {
    /* storage may be unavailable */
  }
}

export function getChosenRdns(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(CHOSEN_SLOT) || "";
  } catch {
    return "";
  }
}

export function ensureDiscovered(timeoutMs = 250): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (registry.length) {
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      resolve();
    };
    const onAnnounce = () => settle();
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    setTimeout(settle, timeoutMs);
  });
}

export function listWallets() {
  refreshWallets();
  return registry.map((d) => ({ name: d.info.name, rdns: d.info.rdns, icon: d.info.icon }));
}

export function pickDetail(rdns?: string): { provider: Eip1193Provider; rdns: string } | undefined {
  refreshWallets();
  const wanted = rdns ?? getChosenRdns();
  if (wanted) {
    const hit = registry.find((d) => d.info.rdns === wanted);
    if (hit) return { provider: hit.provider, rdns: hit.info.rdns };
  }
  for (const r of PREFERENCE) {
    const hit = registry.find((d) => d.info.rdns === r);
    if (hit) return { provider: hit.provider, rdns: hit.info.rdns };
  }
  if (registry[0]) return { provider: registry[0].provider, rdns: registry[0].info.rdns };
  return undefined;
}

export function pickProvider(rdns?: string): Eip1193Provider | undefined {
  const d = pickDetail(rdns);
  if (d) return d.provider;
  return typeof window !== "undefined" ? (window.ethereum as Eip1193Provider | undefined) : undefined;
}
