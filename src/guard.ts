/**
 * AgentForge Guard: run /v1/preflight on every transaction, signature and
 * x402 payment an agent produces, and refuse to sign on an `avoid` verdict.
 *
 * The LLM no longer decides whether to check; the wallet layer enforces it.
 * A prompt-injected agent can be talked into *wanting* to drain a wallet, but
 * it cannot talk the guard out of refusing.
 *
 *   const account = guardAccount(privateKeyToAccount(KEY), { privateKey: KEY });
 *   const client  = guardWalletClient(createWalletClient({ account, chain: base, transport: http() }), { privateKey: KEY });
 *   x402.onBeforePaymentCreation(agentForgePaymentHook({ privateKey: KEY }));
 *
 * Fail-closed by default: if AgentForge cannot be reached, the action is
 * refused (`GuardUnavailableError`). Set `failOpen: true` to sign anyway.
 */

import { walletActions, type Account, type WalletClient } from 'viem';
import { DEFAULT_BASE_URL, type EvmChain, type Json } from './client.js';
import { createCreditFetch, type CreditFetchOptions } from './credits.js';

export const GUARD_VERSION = '0.5.0';

/** Chain ids AgentForge can preflight; anything else is passed through as `chain: undefined` (server default: base). */
export const CHAIN_BY_ID: Record<number, EvmChain | 'hyperevm'> = {
  1: 'ethereum', 8453: 'base', 42161: 'arbitrum', 10: 'optimism', 137: 'polygon',
  56: 'bsc', 43114: 'avalanche', 59144: 'linea', 130: 'unichain', 146: 'sonic', 999: 'hyperevm',
};

export type Verdict = 'proceed' | 'caution' | 'avoid';

export interface PreflightReport {
  verdict: Verdict;
  reasons?: string[];
  [k: string]: unknown;
}

export interface GuardOptions {
  /** Wallet that pays for the checks ($0.008 each, from prepaid credits with auto top-up). Either this or `fetch`. */
  privateKey?: `0x${string}`;
  /** A fetch that can pay AgentForge (createCreditFetch / createPayingFetch). Overrides `privateKey`. */
  fetch?: typeof fetch;
  /** Credit auto top-up and referral settings (see createCreditFetch). */
  credits?: Omit<CreditFetchOptions, 'privateKey' | 'baseUrl'>;
  baseUrl?: string;
  /** Chain when it cannot be inferred from the transaction / client / typed data. Default: base. */
  chain?: EvmChain | 'hyperevm';
  /**
   * What to do on a `caution` verdict: 'allow' (default; logs), 'block', or a
   * function deciding per report.
   */
  onCaution?: 'allow' | 'block' | ((report: PreflightReport) => boolean | Promise<boolean>);
  /** Sign anyway when AgentForge is unreachable or errors. Default false (refuse). */
  failOpen?: boolean;
  /** Where warnings go. Default console.warn. */
  log?: (message: string, report?: PreflightReport) => void;
  /** Called with every report (telemetry, audit logs). */
  onReport?: (report: PreflightReport, input: Json) => void;
  /** Test hook: replace the HTTP call. */
  preflight?: (input: Json) => Promise<PreflightReport>;
}

export class GuardBlockedError extends Error {
  constructor(readonly report: PreflightReport, readonly input: Json) {
    super(`AgentForge Guard refused to sign (${report.verdict}): ${(report.reasons ?? []).slice(0, 3).join('; ') || 'see report'}`);
    this.name = 'GuardBlockedError';
  }
}

export class GuardUnavailableError extends Error {
  constructor(readonly cause: unknown, readonly input: Json) {
    super(`AgentForge Guard could not check this action and failOpen is false: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'GuardUnavailableError';
  }
}

export interface Guard {
  /** Run preflight on an arbitrary input; throws GuardBlockedError / GuardUnavailableError. Returns the report. */
  check(input: Json): Promise<PreflightReport>;
  readonly baseUrl: string;
  readonly fetch: typeof fetch;
}

/** JSON.stringify that survives bigint (viem uses it for value, chainId, nonce, permit amounts). */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}

function chainFor(chainId: number | undefined, fallback?: EvmChain | 'hyperevm'): string | undefined {
  return (chainId !== undefined && CHAIN_BY_ID[chainId]) || fallback;
}

/** Build the shared guard (one per wallet/fetch). The wrappers below all use it. */
export function createGuard(opts: GuardOptions = {}): Guard {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const fetchFn: typeof fetch = opts.fetch
    ?? (opts.privateKey
      ? createCreditFetch({ privateKey: opts.privateKey, baseUrl, ...(opts.credits ?? {}) })
      : fetch);
  const log = opts.log ?? ((m: string) => console.warn(m));

  const callPreflight = opts.preflight ?? (async (input: Json): Promise<PreflightReport> => {
    const res = await fetchFn(`${baseUrl}/v1/preflight`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-agentforge-client': `agentforge-tools/${GUARD_VERSION} guard` },
      body: toJson(input),
    });
    const text = await res.text();
    if (!res.ok) {
      const hint = res.status === 402 ? ' (pass privateKey or a paying fetch to the guard)' : '';
      throw new Error(`preflight HTTP ${res.status}${hint}: ${text.slice(0, 200)}`);
    }
    return JSON.parse(text) as PreflightReport;
  });

  async function check(input: Json): Promise<PreflightReport> {
    let report: PreflightReport;
    try {
      report = await callPreflight(input);
    } catch (e) {
      if (opts.failOpen) {
        log(`AgentForge Guard: check failed, signing anyway (failOpen): ${e instanceof Error ? e.message : e}`);
        return { verdict: 'proceed', reasons: ['guard unavailable; failOpen'] };
      }
      throw new GuardUnavailableError(e, input);
    }
    opts.onReport?.(report, input);
    if (report.verdict === 'avoid') throw new GuardBlockedError(report, input);
    if (report.verdict === 'caution') {
      const mode = opts.onCaution ?? 'allow';
      const allow = mode === 'allow' ? true : mode === 'block' ? false : await mode(report);
      if (!allow) throw new GuardBlockedError(report, input);
      log(`AgentForge Guard: caution, proceeding: ${(report.reasons ?? []).slice(0, 3).join('; ')}`, report);
    }
    return report;
  }

  return { check, baseUrl, fetch: fetchFn };
}

type TxLike = { to?: string | null; data?: string; value?: bigint | string | number; chainId?: number; from?: string; account?: unknown; chain?: { id?: number } | null };

/** Preflight body for one transaction about to be signed or sent. */
export function txInput(tx: TxLike, from: string, opts: { chainId?: number; chain?: EvmChain | 'hyperevm' } = {}): Json {
  const chainId = tx.chainId ?? tx.chain?.id ?? opts.chainId;
  const t: Json = { to: tx.to ?? undefined };
  if (tx.data && tx.data !== '0x') t.data = tx.data;
  if (tx.value !== undefined && tx.value !== null) t.value = typeof tx.value === 'bigint' ? tx.value.toString() : String(tx.value);
  const input: Json = { from, transactions: [t] };
  const chain = chainFor(chainId, opts.chain);
  if (chain) input.chain = chain;
  return input;
}

/** Preflight body for EIP-712 typed data about to be signed. */
export function typedDataInput(typedData: unknown, signer: string, opts: { chain?: EvmChain | 'hyperevm' } = {}): Json {
  const td = typedData as { domain?: { chainId?: bigint | number | string } };
  const rawId = td?.domain?.chainId;
  const chainId = rawId === undefined ? undefined : Number(rawId);
  const input: Json = { typedData: JSON.parse(toJson(typedData)), signer };
  const chain = chainFor(chainId, opts.chain);
  if (chain) input.chain = chain;
  return input;
}

/**
 * Wrap a viem account (privateKeyToAccount, mnemonicToAccount, custom
 * accounts). Every signTransaction / signTypedData runs preflight first.
 * signMessage is left alone: personal_sign cannot move funds by itself.
 */
export function guardAccount<A extends Account>(account: A, opts: GuardOptions = {}): A {
  const guard = createGuard(opts);
  const a = account as A & {
    signTransaction?: (tx: TxLike, ...rest: unknown[]) => Promise<unknown>;
    signTypedData?: (td: unknown, ...rest: unknown[]) => Promise<unknown>;
  };
  const wrapped: Record<string, unknown> = {};
  if (typeof a.signTransaction === 'function') {
    const orig = a.signTransaction.bind(a);
    wrapped.signTransaction = async (tx: TxLike, ...rest: unknown[]) => {
      await guard.check(txInput(tx, account.address, { chain: opts.chain }));
      return orig(tx, ...rest);
    };
  }
  if (typeof a.signTypedData === 'function') {
    const orig = a.signTypedData.bind(a);
    wrapped.signTypedData = async (td: unknown, ...rest: unknown[]) => {
      await guard.check(typedDataInput(td, account.address, { chain: opts.chain }));
      return orig(td, ...rest);
    };
  }
  return Object.assign({}, account, wrapped, { __agentforgeGuard: guard }) as A;
}

/**
 * Wrap a viem WalletClient. sendTransaction, signTransaction, signTypedData
 * and sendRawTransaction-free paths (writeContract, which calls the client's
 * sendTransaction) all run preflight first.
 */
export function guardWalletClient<C extends WalletClient>(client: C, opts: GuardOptions = {}): C {
  const guard = createGuard(opts);
  const c = client as C & Record<string, unknown>;
  const fromOf = (args: TxLike): string => {
    const acct = args.account as { address?: string } | string | undefined;
    return (typeof acct === 'string' ? acct : acct?.address) ?? client.account?.address ?? '';
  };
  const chainId = client.chain?.id;
  const wrapped: Record<string, unknown> = {};
  for (const name of ['sendTransaction', 'signTransaction'] as const) {
    const orig = c[name];
    if (typeof orig !== 'function') continue;
    wrapped[name] = async (args: TxLike, ...rest: unknown[]) => {
      await guard.check(txInput(args, fromOf(args), { chainId, chain: opts.chain }));
      return (orig as (...a: unknown[]) => Promise<unknown>).call(wrapped, args, ...rest);
    };
  }
  if (typeof c.signTypedData === 'function') {
    const orig = c.signTypedData as (...a: unknown[]) => Promise<unknown>;
    wrapped.signTypedData = async (args: TxLike & { domain?: unknown }, ...rest: unknown[]) => {
      await guard.check(typedDataInput(args, fromOf(args), { chain: opts.chain }));
      return orig.call(wrapped, args, ...rest);
    };
  }
  // viem binds decorated actions (writeContract, sendTransaction, ...) to the
  // client object they were created on, so a copy must be re-decorated: then
  // writeContract's getAction() resolves to the guarded sendTransaction below.
  const copy = Object.assign(Object.create(Object.getPrototypeOf(client)), client) as C & Record<string, unknown>;
  Object.assign(copy, walletActions(copy as never), wrapped, { __agentforgeGuard: guard });
  return copy as C;
}

/**
 * Decode an x402 PaymentRequired (the base64 `PAYMENT-REQUIRED` header, or the
 * JSON body of a 402). Returns undefined when it is not one.
 */
export function decodePaymentRequired(res: Response): Json | undefined {
  const h = res.headers.get('payment-required') ?? res.headers.get('x-payment-required');
  if (h) {
    try {
      return JSON.parse(Buffer.from(h, 'base64').toString('utf8')) as Json;
    } catch {
      /* fall through */
    }
  }
  return undefined;
}

export interface PaymentGuardOptions extends GuardOptions {
  /** Refuse to pay more than this per payment, in USD, even if the guard says proceed. */
  expectedMaxUsd?: number;
}

/**
 * An `@x402/core` client hook: `client.onBeforePaymentCreation(agentForgePaymentHook(opts))`.
 * Before the wallet signs any x402 payment, the PaymentRequired is sent to
 * preflight (payTo screened for sanctions/scams, asset verified as real USDC,
 * price compared with the seller's listed price). `avoid` aborts the payment.
 * Payments to AgentForge itself are skipped, so paying for the check never
 * recurses.
 */
export function agentForgePaymentHook(opts: PaymentGuardOptions = {}) {
  const guard = createGuard(opts);
  const ownHost = new URL(guard.baseUrl).host;
  return async (context: { paymentRequired: unknown; selectedRequirements: unknown }): Promise<void | { abort: true; reason: string }> => {
    const pr = context.paymentRequired as Json;
    const resource = (pr?.resource as { url?: string } | undefined)?.url ?? (context.selectedRequirements as { resource?: string })?.resource;
    if (resource && safeHost(resource) === ownHost) return;
    const input: Json = { paymentRequired: pr };
    if (opts.expectedMaxUsd) input.expectedMaxUsd = opts.expectedMaxUsd;
    try {
      await guard.check(input);
    } catch (e) {
      if (e instanceof GuardBlockedError || e instanceof GuardUnavailableError) return { abort: true, reason: e.message };
      throw e;
    }
  };
}

/**
 * For x402 clients without `onBeforePaymentCreation` (older @x402 versions,
 * other languages' fetch shims): wrap the *paying* fetch. The request is sent
 * unpaid first; on a 402 the PaymentRequired is checked, then the paying fetch
 * repeats the call. Costs one extra round trip per paid call.
 */
export function guardPayingFetch(payingFetch: typeof fetch, opts: PaymentGuardOptions = {}, plainFetch: typeof fetch = fetch): typeof fetch {
  const guard = createGuard(opts);
  const ownHost = new URL(guard.baseUrl).host;
  return (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const target = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (safeHost(target) === ownHost) return payingFetch(url, init);
    const probe = await plainFetch(url, init);
    if (probe.status !== 402) return probe;
    const pr = decodePaymentRequired(probe);
    if (pr) {
      const input: Json = { paymentRequired: pr };
      if (opts.expectedMaxUsd) input.expectedMaxUsd = opts.expectedMaxUsd;
      await guard.check(input);
    }
    return payingFetch(url, init);
  }) as typeof fetch;
}

function safeHost(u: string): string | undefined {
  try {
    return new URL(u).host;
  } catch {
    return undefined;
  }
}
