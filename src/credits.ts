/**
 * Prepaid credits: pay AgentForge once over x402, then authorize each call by
 * signing it (no per-call settlement, no facilitator fee), with automatic
 * top-up when the balance runs low.
 *
 * Header: X-AgentForge-Credit: base64(JSON { wallet, ts, nonce, sig })
 * Signed message (EIP-191 personal_sign), lines joined with "\n":
 *   AgentForge credit spend / method:<METHOD> / path:<path> / query:<raw query>
 *   / body-sha256:<hex> / ts:<unix s> / nonce:<32 hex>
 */

import { privateKeyToAccount } from 'viem/accounts';
import { DEFAULT_BASE_URL, createPayingFetch } from './client.js';

export type Pack = 1 | 5 | 20;

export interface CreditFetchOptions {
  /** Wallet holding USDC on Base: signs credit spends and pays top-ups. */
  privateKey: `0x${string}`;
  baseUrl?: string;
  /**
   * Buy a pack when the balance drops under `whenBelowUsd` (default: pack 5
   * when under $0.50). `false` disables top-up: calls fall back to per-call
   * x402 when credits run out.
   */
  autoTopUp?: { pack?: Pack; whenBelowUsd?: number } | false;
  /**
   * Your wallet address. You earn 10% of every credit pack this agent buys,
   * for as long as it keeps buying; the agent gets 5% extra credit. Plugin and
   * framework authors: set this to your own wallet.
   */
  referrer?: string;
  /** x402-paying fetch used for top-ups and fallbacks. Default: createPayingFetch({ privateKey }). */
  payingFetch?: typeof fetch;
  /** Per-payment cap for the paying fetch (default $25, enough for the $20 pack). */
  maxPaymentUsd?: number;
  /** Plain fetch (tests). */
  fetch?: typeof fetch;
  /** Re-check the balance at most this often, ms (default 60s). */
  balanceCheckIntervalMs?: number;
  /** Never top up more often than this, ms (default 10 min). */
  topUpCooldownMs?: number;
}

export interface CreditFetch {
  (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response>;
  /** Buy a pack now. Returns the server's response body. */
  topUp(pack?: Pack): Promise<unknown>;
  /** Current balance in USD (fresh call). */
  balance(): Promise<number>;
  readonly wallet: `0x${string}`;
}

const X402_ONLY = new Set(['/v1/credits/buy', '/v1/ping']);

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function nonce32(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function creditMessage(p: { method: string; path: string; query: string; bodySha256: string; ts: number; nonce: string }): string {
  return ['AgentForge credit spend', `method:${p.method.toUpperCase()}`, `path:${p.path}`, `query:${p.query}`, `body-sha256:${p.bodySha256}`, `ts:${p.ts}`, `nonce:${p.nonce}`].join('\n');
}

/**
 * A fetch that spends prepaid AgentForge credits, tops up automatically, and
 * falls back to per-call x402 for anything credits cannot cover.
 */
export function createCreditFetch(opts: CreditFetchOptions): CreditFetch {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const base = new URL(baseUrl);
  const account = privateKeyToAccount(opts.privateKey);
  const wallet = account.address.toLowerCase() as `0x${string}`;
  const plain = opts.fetch ?? fetch;
  const paying = opts.payingFetch ?? createPayingFetch({ privateKey: opts.privateKey, maxPaymentUsd: opts.maxPaymentUsd ?? 25 });
  const topUp = opts.autoTopUp === false ? null : { pack: (opts.autoTopUp?.pack ?? 5) as Pack, whenBelowUsd: opts.autoTopUp?.whenBelowUsd ?? 0.5 };
  const checkEvery = opts.balanceCheckIntervalMs ?? 60_000;
  const cooldown = opts.topUpCooldownMs ?? 600_000;
  let lastBalanceCheck = 0;
  let lastTopUp = 0;
  let topUpInFlight: Promise<unknown> | null = null;

  const buyUrl = (pack: Pack) => {
    const u = new URL(`${baseUrl}/v1/credits/buy`);
    u.searchParams.set('pack', String(pack));
    if (opts.referrer) u.searchParams.set('ref', opts.referrer);
    return u.toString();
  };

  async function doTopUp(pack: Pack): Promise<unknown> {
    if (topUpInFlight) return topUpInFlight;
    topUpInFlight = (async () => {
      lastTopUp = Date.now();
      const res = await paying(buyUrl(pack), { method: 'POST', headers: { accept: 'application/json' } });
      const text = await res.text();
      if (!res.ok) throw new Error(`credit top-up failed: HTTP ${res.status} ${text.slice(0, 200)}`);
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    })().finally(() => {
      topUpInFlight = null;
    });
    return topUpInFlight;
  }

  async function balance(): Promise<number> {
    const res = await plain(`${baseUrl}/credits/balance?wallet=${wallet}`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`balance check failed: HTTP ${res.status}`);
    const body = (await res.json()) as { balanceUsd?: string };
    return Number(String(body.balanceUsd ?? '0').replace(/^\$/, '')) || 0;
  }

  async function maybeTopUp(): Promise<void> {
    if (!topUp || Date.now() - lastBalanceCheck < checkEvery) return;
    lastBalanceCheck = Date.now();
    let bal: number;
    try {
      bal = await balance();
    } catch {
      return;
    }
    if (bal < topUp.whenBelowUsd && Date.now() - lastTopUp > cooldown) {
      await doTopUp(topUp.pack).catch((e) => console.warn(`AgentForge credits: ${e instanceof Error ? e.message : e}`));
    }
  }

  const creditFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      return plain(input, init);
    }
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.host !== base.host || !url.pathname.startsWith('/v1/') || X402_ONLY.has(url.pathname)) return paying(input, init);

    await maybeTopUp();

    const body = method === 'GET' ? '' : typeof init?.body === 'string' ? init.body : init?.body ? String(init.body) : '';
    const ts = Math.floor(Date.now() / 1000);
    const nonce = nonce32();
    const message = creditMessage({ method, path: url.pathname, query: url.search.replace(/^\?/, ''), bodySha256: await sha256Hex(body), ts, nonce });
    const sig = await account.signMessage({ message });
    const header = Buffer.from(JSON.stringify({ wallet, ts, nonce, sig })).toString('base64');
    const headers = new Headers(init?.headers);
    headers.set('x-agentforge-credit', header);
    const res = await plain(input, { ...init, headers });
    if (res.status !== 402) return res;
    // Out of credits: top up (if enabled) and pay this call with x402 either way.
    if (topUp && Date.now() - lastTopUp > cooldown) {
      await doTopUp(topUp.pack).catch((e) => console.warn(`AgentForge credits: ${e instanceof Error ? e.message : e}`));
    }
    return paying(input, init);
  }) as CreditFetch;

  Object.assign(creditFetch, { topUp: (pack?: Pack) => doTopUp(pack ?? topUp?.pack ?? 5), balance, wallet });
  return creditFetch;
}
