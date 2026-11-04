/**
 * Live acceptance for the Guard against production (costs about $0.02 in USDC
 * from TEST_WALLET_PRIVATE_KEY on Base; the owner runs this, never automation):
 *   1. a native transfer to an OFAC-listed address must be BLOCKED (avoid);
 *   2. a WETH deposit (wrap 1 wei) must PASS (proceed or caution).
 * Nothing is broadcast: only signTransaction is exercised.
 *
 *   TEST_WALLET_PRIVATE_KEY=0x… npx tsx scripts/guardAcceptance.ts
 */
import { privateKeyToAccount } from 'viem/accounts';
import { encodeFunctionData, parseAbi } from 'viem';
import { guardAccount, GuardBlockedError, createPayingFetch } from '../src/index.js';

const key = process.env.TEST_WALLET_PRIVATE_KEY as `0x${string}` | undefined;
if (!key) throw new Error('TEST_WALLET_PRIVATE_KEY not set');
const account = privateKeyToAccount(key);
// Per-call x402 here (no credits), so the run leaves no balance behind.
const guarded = guardAccount(account, { fetch: createPayingFetch({ privateKey: key, maxPaymentUsd: 0.05 }), onReport: (r) => console.log('  report:', r.verdict, (r.reasons ?? []).slice(0, 3)) });
const base = { chainId: 8453, type: 'eip1559' as const, maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 1_000n, gas: 60_000n, nonce: 0 };

// Must be on the CURRENT OFAC SDN list. Tornado Cash contracts were delisted
// in March 2025, so they correctly come back `caution`, not `avoid`. This one
// is the first Ethereum entry in AgentForge's list (refreshed monthly from the
// SDN extraction at github.com/0xB10C/ofac-sanctioned-digital-currency-addresses).
console.log('1. transfer to an OFAC SDN-listed address …');
const OFAC = '0x0330070FD38EC3BB94F58fa55D40368271E9e54A';
try {
  await guarded.signTransaction({ ...base, to: OFAC, value: 1n });
  console.log('  FAIL: signed');
  process.exit(1);
} catch (e) {
  if (!(e instanceof GuardBlockedError)) throw e;
  console.log('  BLOCKED as expected:', e.message);
}

console.log('2. WETH deposit of 1 wei …');
const WETH = '0x4200000000000000000000000000000000000006';
const data = encodeFunctionData({ abi: parseAbi(['function deposit() payable']), functionName: 'deposit' });
const sig = await guarded.signTransaction({ ...base, to: WETH, value: 1n, data });
console.log('  signed (not broadcast):', `${sig.slice(0, 20)}…`);
console.log('ACCEPTANCE PASSED');
