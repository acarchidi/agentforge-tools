/**
 * AgentForge client: typed methods over the AgentForge x402 API.
 *
 * Every paid endpoint answers an unpaid request with HTTP 402 and its exact
 * price; an x402-wrapped fetch (see createPayingFetch) pays that automatically
 * in USDC on Base, within a per-call spending cap.
 */

import { x402Client, wrapFetchWithPayment } from '@x402/fetch';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';

export const DEFAULT_BASE_URL = 'https://agentforge-taupe.vercel.app';

export type EvmChain = 'ethereum' | 'base' | 'arbitrum' | 'optimism' | 'polygon';
export type Json = Record<string, unknown>;

export class AgentForgeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'AgentForgeError';
  }
}

export interface PayingFetchOptions {
  /** 0x-prefixed private key of a Base wallet holding USDC. Gasless: x402 uses signed authorizations. */
  privateKey: `0x${string}`;
  /** Refuse any single payment above this many USD. Default $0.50 (AgentForge's priciest call is $0.35). */
  maxPaymentUsd?: number;
}

/**
 * A fetch that pays x402 challenges from the given wallet, refusing any single
 * payment above `maxPaymentUsd`. Pass it to `new AgentForge({ fetch })`.
 */
export function createPayingFetch(opts: PayingFetchOptions): typeof fetch {
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: privateKeyToAccount(opts.privateKey) });
  client.setSpendControls({ maxAmountPerPayment: `$${opts.maxPaymentUsd ?? 0.5}` });
  return wrapFetchWithPayment(fetch, client) as typeof fetch;
}

export interface AgentForgeOptions {
  /** x402-paying fetch (createPayingFetch, or your own wrapFetchWithPayment). Plain fetch gets 402s. */
  fetch?: typeof fetch;
  /** Shorthand: build a paying fetch from this private key. */
  privateKey?: `0x${string}`;
  maxPaymentUsd?: number;
  baseUrl?: string;
}

export interface Tx {
  to: string;
  /** Calldata, 0x-hex. */
  data?: string;
  /** Wei as hex or decimal string. */
  value?: string;
}

export class AgentForge {
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;

  constructor(opts: AgentForgeOptions = {}) {
    this.fetchFn = opts.fetch
      ?? (opts.privateKey ? createPayingFetch({ privateKey: opts.privateKey, maxPaymentUsd: opts.maxPaymentUsd }) : fetch);
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  }

  private async call<T = Json>(method: 'GET' | 'POST', path: string, input?: Json): Promise<T> {
    let url = `${this.baseUrl}${path}`;
    const init: RequestInit = { method, headers: { accept: 'application/json' } };
    if (method === 'GET' && input) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(input)) if (v !== undefined && v !== null) qs.set(k, String(v));
      if ([...qs].length) url += `?${qs}`;
    } else if (input) {
      init.body = JSON.stringify(input);
      (init.headers as Record<string, string>)['content-type'] = 'application/json';
    }
    const res = await this.fetchFn(url, init);
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // keep text
    }
    if (!res.ok) {
      const hint = res.status === 402
        ? ' (payment required: construct AgentForge with { privateKey } or an x402-paying fetch)'
        : '';
      throw new AgentForgeError(`AgentForge ${method} ${path} failed: ${res.status}${hint}`, res.status, body);
    }
    return body as T;
  }

  /** $0.005 — Simulate 1-5 EVM transactions before signing: reverts, asset changes, approvals, counterparty screening, proceed/caution/avoid. */
  simulateTransaction(input: { from: string; transactions: Tx[]; chain?: EvmChain }) {
    return this.call('POST', '/v1/tx-simulate', input);
  }

  /** $0.003 + $0.001 per extra address — Screen 1-100 EVM/Solana addresses against OFAC sanctions and scam lists. */
  checkAddresses(input: { addresses: Array<{ address: string; chain?: EvmChain | 'solana' }>; chain?: EvmChain | 'solana' }) {
    return this.call('POST', '/v1/address-check', input);
  }

  /** $0.025 — Pre-trade token check: rug-check metrics + AI risk assessment + gas, with a verdict. */
  tradeCheck(input: { address: string; chain?: 'ethereum' | 'base' | 'polygon' | 'arbitrum' }) {
    return this.call('POST', '/v1/trade-check', input);
  }

  /** $0.005 — Newly launched tokens, already risk-scored. Pass the previous nextSince as `since` to poll. */
  launches(input: { chain?: 'base' | 'ethereum' | 'arbitrum'; since?: string; minLiquidityUsd?: number; maxRiskScore?: number; limit?: number } = {}) {
    return this.call('GET', '/v1/launches', input);
  }

  /** $0.004 per token — Rug-check 2-25 EVM tokens in one call. */
  scoreTokens(input: { tokens: Array<{ address: string; chain?: EvmChain }>; chain?: EvmChain }) {
    return this.call('POST', '/v1/risk-batch', input);
  }

  /** $0.003 — Aave v3 liquidation risk across five chains. */
  lendingHealth(input: { address: string; chain?: EvmChain | 'all' }) {
    return this.call('GET', '/v1/lending/health', input);
  }

  /** Holder, permission and liquidity risk metrics for one ERC-20. */
  tokenRisk(input: { address: string; chain?: EvmChain }) {
    return this.call('POST', '/v1/token-risk-metrics', input);
  }

  /** Wallet safety: approvals, activity patterns, target contract risk. */
  walletSafety(input: { walletAddress: string; chain?: EvmChain; targetContract?: string }) {
    return this.call('POST', '/v1/wallet-safety', input);
  }

  /** Risky ERC-20 approvals held on a wallet. */
  approvalScan(input: { address: string; chain?: EvmChain }) {
    return this.call('POST', '/v1/approval-scan', input);
  }

  /** Plain-English decode of an EVM transaction hash. */
  decodeTransaction(input: { txHash: string; chain?: EvmChain }) {
    return this.call('POST', '/v1/tx-decode', input);
  }

  /** $0.001 — Verify your x402 setup; returns the service catalog. */
  ping() {
    return this.call('GET', '/v1/ping');
  }
}
