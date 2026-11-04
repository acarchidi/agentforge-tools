import { describe, it, expect, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, http, parseEther, verifyMessage } from 'viem';
import { base } from 'viem/chains';
import {
  guardAccount, guardWalletClient, agentForgePaymentHook, guardPayingFetch, GuardBlockedError, GuardUnavailableError,
  createCreditFetch, creditMessage, guardWalletProvider, txInput, typedDataInput,
} from '../src/index.js';
import { extractAction } from '../src/cli.js';

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const; // hardhat #1, no funds
const account = privateKeyToAccount(KEY);
const SANCTIONED = '0x8589427373D6D84E98730D7795D8f6f8731FDA16';

function preflightMock(verdict: 'proceed' | 'caution' | 'avoid', status = 200) {
  return vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(JSON.stringify({ verdict, reasons: [`${verdict} reason`] }), { status, headers: { 'content-type': 'application/json' } }));
}
const bodyOf = (f: ReturnType<typeof vi.fn>, i = 0) => JSON.parse(String((f.mock.calls[i] as unknown[])[1] && ((f.mock.calls[i] as [string, RequestInit])[1]).body));

describe('guardAccount', () => {
  it('runs preflight with the transaction and signs on proceed', async () => {
    const f = preflightMock('proceed');
    const g = guardAccount(account, { fetch: f as unknown as typeof fetch });
    const sig = await g.signTransaction({ to: SANCTIONED, value: parseEther('0.01'), chainId: 8453, type: 'eip1559', maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, gas: 21000n, nonce: 0 });
    expect(sig).toMatch(/^0x02/);
    expect(f.mock.calls[0][0]).toBe('https://agentforge-taupe.vercel.app/v1/preflight');
    expect(bodyOf(f)).toEqual({ from: account.address, chain: 'base', transactions: [{ to: SANCTIONED, value: '10000000000000000' }] });
  });

  it('refuses to sign on avoid', async () => {
    const g = guardAccount(account, { fetch: preflightMock('avoid') as unknown as typeof fetch });
    await expect(g.signTransaction({ to: SANCTIONED, chainId: 8453, type: 'eip1559', maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, gas: 21000n, nonce: 0 }))
      .rejects.toBeInstanceOf(GuardBlockedError);
  });

  it('caution: allows by default, blocks with onCaution=block, consults a function', async () => {
    const tx = { to: SANCTIONED, chainId: 8453, type: 'eip1559', maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, gas: 21000n, nonce: 0 } as const;
    const log = vi.fn();
    await expect(guardAccount(account, { fetch: preflightMock('caution') as unknown as typeof fetch, log }).signTransaction(tx)).resolves.toMatch(/^0x/);
    expect(log).toHaveBeenCalled();
    await expect(guardAccount(account, { fetch: preflightMock('caution') as unknown as typeof fetch, onCaution: 'block' }).signTransaction(tx)).rejects.toBeInstanceOf(GuardBlockedError);
    const decide = vi.fn(async () => false);
    await expect(guardAccount(account, { fetch: preflightMock('caution') as unknown as typeof fetch, onCaution: decide }).signTransaction(tx)).rejects.toBeInstanceOf(GuardBlockedError);
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'caution' }));
  });

  it('fails closed on errors unless failOpen', async () => {
    const tx = { to: SANCTIONED, chainId: 8453, type: 'eip1559', maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, gas: 21000n, nonce: 0 } as const;
    await expect(guardAccount(account, { fetch: preflightMock('proceed', 500) as unknown as typeof fetch }).signTransaction(tx)).rejects.toBeInstanceOf(GuardUnavailableError);
    const err402 = await guardAccount(account, { fetch: preflightMock('proceed', 402) as unknown as typeof fetch }).signTransaction(tx).catch((e) => e);
    expect(err402.message).toMatch(/privateKey/);
    await expect(guardAccount(account, { fetch: preflightMock('proceed', 500) as unknown as typeof fetch, failOpen: true, log: () => {} }).signTransaction(tx)).resolves.toMatch(/^0x/);
  });

  it('checks typed data with the signer and the domain chain', async () => {
    const f = preflightMock('avoid');
    const g = guardAccount(account, { fetch: f as unknown as typeof fetch });
    const typedData = {
      domain: { name: 'USD Coin', version: '2', chainId: 8453n, verifyingContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
      types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
      primaryType: 'Permit' as const,
      message: { owner: account.address, spender: SANCTIONED, value: 2n ** 256n - 1n, nonce: 0n, deadline: 2n ** 48n },
    };
    await expect(g.signTypedData(typedData)).rejects.toBeInstanceOf(GuardBlockedError);
    const body = bodyOf(f);
    expect(body.signer).toBe(account.address);
    expect(body.chain).toBe('base');
    expect(body.typedData.message.value).toBe((2n ** 256n - 1n).toString());
  });

  it('leaves signMessage alone and keeps the address', async () => {
    const f = preflightMock('avoid');
    const g = guardAccount(account, { fetch: f as unknown as typeof fetch });
    expect(g.address).toBe(account.address);
    const sig = await g.signMessage({ message: 'hi' });
    expect(await verifyMessage({ address: account.address, message: 'hi', signature: sig })).toBe(true);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('guardWalletClient', () => {
  it('intercepts sendTransaction (and writeContract through it) with the client chain', async () => {
    const f = preflightMock('avoid');
    const client = createWalletClient({ account, chain: base, transport: http('http://127.0.0.1:9') });
    const g = guardWalletClient(client, { fetch: f as unknown as typeof fetch });
    await expect(g.sendTransaction({ to: SANCTIONED, value: 1n })).rejects.toBeInstanceOf(GuardBlockedError);
    expect(bodyOf(f)).toEqual({ from: account.address, chain: 'base', transactions: [{ to: SANCTIONED, value: '1' }] });
    // viem wraps anything sendTransaction throws in ContractFunctionExecutionError; the guard error is its cause.
    const err = await g.writeContract({
      address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', abi: [{ type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 's', type: 'address' }, { name: 'a', type: 'uint256' }], outputs: [{ type: 'bool' }] }],
      functionName: 'approve', args: [SANCTIONED, 1n],
    }).catch((e) => e);
    expect(err.walk((e: unknown) => e instanceof GuardBlockedError)).toBeInstanceOf(GuardBlockedError);
    expect(bodyOf(f, 1).transactions[0].data).toMatch(/^0x095ea7b3/);
  });
});

describe('agentForgePaymentHook / guardPayingFetch', () => {
  const paymentRequired = {
    x402Version: 2, resource: { url: 'https://seller.example/v1/thing' },
    accepts: [{ scheme: 'exact', network: 'eip155:8453', amount: '10000', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', payTo: SANCTIONED }],
  };
  it('aborts the payment on avoid and skips payments to AgentForge itself', async () => {
    const f = preflightMock('avoid');
    const hook = agentForgePaymentHook({ fetch: f as unknown as typeof fetch, expectedMaxUsd: 0.05 });
    const out = await hook({ paymentRequired, selectedRequirements: paymentRequired.accepts[0] });
    expect(out).toEqual({ abort: true, reason: expect.stringMatching(/refused/) });
    expect(bodyOf(f)).toEqual({ paymentRequired, expectedMaxUsd: 0.05 });
    const own = { ...paymentRequired, resource: { url: 'https://agentforge-taupe.vercel.app/v1/preflight' } };
    expect(await hook({ paymentRequired: own, selectedRequirements: own.accepts[0] })).toBeUndefined();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('guardPayingFetch probes, checks the 402, then pays', async () => {
    const guardApi = preflightMock('proceed');
    const header = Buffer.from(JSON.stringify(paymentRequired)).toString('base64');
    const plain = vi.fn(async () => new Response('{}', { status: 402, headers: { 'payment-required': header } }));
    const paying = vi.fn(async () => new Response('{"ok":1}', { status: 200 }));
    const f = guardPayingFetch(paying as unknown as typeof fetch, { fetch: guardApi as unknown as typeof fetch }, plain as unknown as typeof fetch);
    const res = await f('https://seller.example/v1/thing');
    expect(res.status).toBe(200);
    expect(plain).toHaveBeenCalledTimes(1);
    expect(paying).toHaveBeenCalledTimes(1);
    expect(bodyOf(guardApi).paymentRequired.accepts[0].payTo).toBe(SANCTIONED);
    const blocked = guardPayingFetch(paying as unknown as typeof fetch, { fetch: preflightMock('avoid') as unknown as typeof fetch }, plain as unknown as typeof fetch);
    await expect(blocked('https://seller.example/v1/thing')).rejects.toBeInstanceOf(GuardBlockedError);
  });
});

describe('guardWalletProvider (AgentKit)', () => {
  class FakeProvider {
    calls: string[] = [];
    getAddress() { return account.address; }
    getNetwork() { return { chainId: '8453', protocolFamily: 'evm' }; }
    getName() { return 'fake'; }
    async nativeTransfer(to: string, value: string) { this.calls.push(`transfer ${to} ${value}`); return '0xhash'; }
    async sendTransaction(tx: { to: string }) { this.calls.push(`send ${tx.to}`); return '0xhash'; }
    async signTypedData(_td: unknown) { return '0xsig'; }
  }
  it('blocks nativeTransfer/sendTransaction on avoid and keeps this bound', async () => {
    const f = preflightMock('avoid');
    const p = guardWalletProvider(new FakeProvider(), { fetch: f as unknown as typeof fetch });
    await expect(p.nativeTransfer(SANCTIONED, '0.01')).rejects.toBeInstanceOf(GuardBlockedError);
    expect(bodyOf(f)).toEqual({ from: account.address, chain: 'base', transactions: [{ to: SANCTIONED, value: '10000000000000000' }] });
    expect(p.getName()).toBe('fake');
    const ok = guardWalletProvider(new FakeProvider(), { fetch: preflightMock('proceed') as unknown as typeof fetch });
    expect(await ok.sendTransaction({ to: SANCTIONED })).toBe('0xhash');
    expect(ok.calls).toEqual([`send ${SANCTIONED}`]);
  });
});

describe('createCreditFetch', () => {
  const BASE = 'https://af.test';
  function server(balanceUsd: string, spendStatus = 200) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const plain = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.startsWith(`${BASE}/credits/balance`)) return new Response(JSON.stringify({ balanceUsd }), { status: 200 });
      return new Response(JSON.stringify({ verdict: 'proceed' }), { status: spendStatus });
    });
    const paying = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: `PAY ${url}`, init });
      return new Response(JSON.stringify({ status: 'credited_on_settlement' }), { status: 200 });
    });
    return { plain, paying, calls };
  }

  it('signs a credit header the server can verify', async () => {
    const s = server('$4.00');
    const cf = createCreditFetch({ privateKey: KEY, baseUrl: BASE, fetch: s.plain as unknown as typeof fetch, payingFetch: s.paying as unknown as typeof fetch });
    const body = JSON.stringify({ chain: 'base', recipients: [SANCTIONED] });
    const res = await cf(`${BASE}/v1/preflight?x=1`, { method: 'POST', body, headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(200);
    const spend = s.calls.find((c) => c.url === `${BASE}/v1/preflight?x=1`)!;
    const header = new Headers(spend.init?.headers).get('x-agentforge-credit')!;
    const auth = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    expect(auth.wallet).toBe(account.address.toLowerCase());
    expect(auth.nonce).toMatch(/^[0-9a-f]{32}$/);
    const bodySha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const message = creditMessage({ method: 'POST', path: '/v1/preflight', query: 'x=1', bodySha256: bodySha, ts: auth.ts, nonce: auth.nonce });
    expect(await verifyMessage({ address: account.address, message, signature: auth.sig })).toBe(true);
    expect(s.paying).not.toHaveBeenCalled();
  });

  it('tops up once with the referrer when the balance is low, and pays x402-only routes directly', async () => {
    const s = server('$0.10');
    const cf = createCreditFetch({ privateKey: KEY, baseUrl: BASE, fetch: s.plain as unknown as typeof fetch, payingFetch: s.paying as unknown as typeof fetch, referrer: '0xReferrer', autoTopUp: { pack: 20, whenBelowUsd: 0.5 } });
    await cf(`${BASE}/v1/preflight`, { method: 'POST', body: '{}' });
    await cf(`${BASE}/v1/preflight`, { method: 'POST', body: '{}' });
    const topUps = s.calls.filter((c) => c.url.startsWith('PAY '));
    expect(topUps).toHaveLength(1);
    expect(topUps[0].url).toBe(`PAY ${BASE}/v1/credits/buy?pack=20&ref=0xReferrer`);
    await cf(`${BASE}/v1/ping`);
    expect(s.calls.at(-1)?.url).toBe(`PAY ${BASE}/v1/ping`);
    await cf('https://elsewhere.test/x');
    expect(s.calls.at(-1)?.url).toBe('PAY https://elsewhere.test/x');
  });

  it('falls back to x402 when credits are insufficient (402)', async () => {
    const s = server('$4.00', 402);
    const cf = createCreditFetch({ privateKey: KEY, baseUrl: BASE, fetch: s.plain as unknown as typeof fetch, payingFetch: s.paying as unknown as typeof fetch, autoTopUp: false });
    const res = await cf(`${BASE}/v1/preflight`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    expect(s.calls.filter((c) => c.url.startsWith('PAY ')).map((c) => c.url)).toEqual([`PAY ${BASE}/v1/preflight`]);
  });
});

describe('helpers', () => {
  it('txInput / typedDataInput map chains and stringify bigints', () => {
    expect(txInput({ to: '0x1', data: '0x', value: 5n, chainId: 42161 }, '0xme')).toEqual({ from: '0xme', chain: 'arbitrum', transactions: [{ to: '0x1', value: '5' }] });
    expect(txInput({ to: '0x1' }, '0xme', { chain: 'bsc' }).chain).toBe('bsc');
    expect(typedDataInput({ domain: { chainId: 1 }, types: {}, primaryType: 'X', message: { a: 1n } }, '0xme')).toEqual({ signer: '0xme', chain: 'ethereum', typedData: { domain: { chainId: 1 }, types: {}, primaryType: 'X', message: { a: '1' } } });
  });

  it('extractAction finds transactions, typed data and PaymentRequired inside tool input', () => {
    expect(extractAction({ command: 'ls' })).toBeUndefined();
    const tx = extractAction({ chain: 'base', from: account.address, tx: { to: SANCTIONED, data: '0xabcdef', value: 1 } })!;
    expect(tx.transactions).toEqual([{ to: SANCTIONED, data: '0xabcdef', value: '1' }]);
    expect(tx.from).toBe(account.address);
    expect(extractAction({ typedData: { domain: {}, types: {}, primaryType: 'Permit', message: {} } })!.typedData).toBeDefined();
    expect(extractAction({ pr: { x402Version: 2, accepts: [] } })!.paymentRequired).toBeDefined();
  });
});
