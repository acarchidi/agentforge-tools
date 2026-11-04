/**
 * Coinbase AgentKit: wrap any EVM WalletProvider so every signTransaction,
 * sendTransaction, signTypedData and nativeTransfer runs AgentForge preflight
 * first. Works with CDP, Privy, viem and smart-wallet providers alike: the
 * wrapper is structural and keeps `this` bound to the original provider.
 *
 *   const wallet = guardWalletProvider(await CdpEvmWalletProvider.configureWithWallet(cfg), { privateKey: GUARD_KEY });
 *   const agentkit = await AgentKit.from({ walletProvider: wallet, actionProviders: [...] });
 */

import { parseUnits } from 'viem';
import type { Json } from './client.js';
import { createGuard, txInput, typedDataInput, type GuardOptions } from './guard.js';

export interface EvmWalletProviderLike {
  getAddress(): string;
  getNetwork(): { chainId?: string | number; networkId?: string; protocolFamily?: string };
  signTransaction?(tx: Json): Promise<unknown>;
  sendTransaction?(tx: Json): Promise<unknown>;
  signTypedData?(typedData: unknown): Promise<unknown>;
  nativeTransfer?(to: string, value: string): Promise<unknown>;
}

export function guardWalletProvider<P extends EvmWalletProviderLike>(provider: P, opts: GuardOptions = {}): P {
  const guard = createGuard(opts);
  const chainId = () => {
    const id = provider.getNetwork()?.chainId;
    return id === undefined ? undefined : Number(id);
  };
  const overrides: Record<string, (...a: never[]) => Promise<unknown>> = {};
  for (const name of ['signTransaction', 'sendTransaction'] as const) {
    if (typeof provider[name] !== 'function') continue;
    overrides[name] = (async (tx: Json) => {
      await guard.check(txInput(tx as { to?: string; data?: string; value?: bigint | string }, provider.getAddress(), { chainId: chainId(), chain: opts.chain }));
      return (provider[name] as (t: Json) => Promise<unknown>).call(provider, tx);
    }) as never;
  }
  if (typeof provider.signTypedData === 'function') {
    overrides.signTypedData = (async (td: unknown) => {
      await guard.check(typedDataInput(td, provider.getAddress(), { chain: opts.chain }));
      return (provider.signTypedData as (t: unknown) => Promise<unknown>).call(provider, td);
    }) as never;
  }
  if (typeof provider.nativeTransfer === 'function') {
    overrides.nativeTransfer = (async (to: string, value: string) => {
      // AgentKit passes whole units (e.g. "0.01" ETH).
      let wei: string | undefined;
      try {
        wei = parseUnits(value, 18).toString();
      } catch {
        wei = undefined;
      }
      await guard.check(txInput({ to, value: wei }, provider.getAddress(), { chainId: chainId(), chain: opts.chain }));
      return (provider.nativeTransfer as (t: string, v: string) => Promise<unknown>).call(provider, to, value);
    }) as never;
  }
  return new Proxy(provider, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && prop in overrides) return overrides[prop];
      if (prop === '__agentforgeGuard') return guard;
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}
