/**
 * Framework-neutral tool definitions: name + description + JSON Schema +
 * execute. Adapt to any agent framework (see README); toOpenAITools() does the
 * OpenAI / function-calling shape.
 */

import type { AgentForge, Json } from './client.js';

export interface AgentForgeTool {
  name: string;
  description: string;
  /** JSON Schema (draft-07 compatible) for the arguments object. */
  parameters: Json;
  execute: (args: any) => Promise<unknown>;
}

const evmChain = { type: 'string', enum: ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'bsc', 'avalanche', 'linea', 'unichain', 'sonic'] };
const address = { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' };

export function agentForgeTools(af: AgentForge): AgentForgeTool[] {
  return [
    {
      name: 'agentforge_preflight',
      description:
        'Is this action safe? Call ONCE before any on-chain action (send, swap, approval, signature, x402 payment). Pass whatever you are about to do: transactions (simulated: reverts, assets out, approvals), EIP-712 typed data or an x402 PaymentRequired (checked for permit phishing), recipients (screened against OFAC sanctions and scam lists), tokens to buy (rug-checked; tokens the simulation shows you receiving are rug-checked automatically). Returns one proceed/caution/avoid verdict with reasons. Costs $0.008 + $0.004 per token in `tokens`.',
      parameters: {
        type: 'object',
        properties: {
          chain: { ...evmChain, description: 'Defaults to the typed data chainId, else base' },
          from: { ...address, description: 'Wallet taking the action (required with transactions)' },
          transactions: {
            type: 'array', maxItems: 5,
            items: { type: 'object', required: ['to'], properties: { to: address, data: { type: 'string' }, value: { type: 'string' } } },
          },
          typedData: { type: 'object', description: 'EIP-712 typed data about to be signed' },
          paymentRequired: { type: 'object', description: 'x402 PaymentRequired about to be paid' },
          expectedMaxUsd: { type: 'number' },
          recipients: { type: 'array', maxItems: 20, items: { type: 'string' }, description: 'Addresses about to receive funds or permissions' },
          tokens: { type: 'array', maxItems: 5, items: address, description: 'Tokens about to be bought' },
        },
      },
      execute: (args) => af.preflight(args),
    },
    {
      name: 'agentforge_simulate_transaction',
      description:
        'Simulate one or more EVM transactions BEFORE signing them. Returns whether each call reverts (with reason), every asset leaving or entering the wallet, approvals granted, sanctions/scam screening of every counterparty, and a proceed/caution/avoid verdict. Use before signing any transaction. Costs $0.005 USDC.',
      parameters: {
        type: 'object',
        required: ['from', 'transactions'],
        properties: {
          chain: { ...evmChain, default: 'base' },
          from: { ...address, description: 'Wallet that will sign' },
          transactions: {
            type: 'array', minItems: 1, maxItems: 5,
            description: 'Executed in order; state carries over (e.g. approve then swap)',
            items: {
              type: 'object', required: ['to'],
              properties: { to: address, data: { type: 'string', description: 'Calldata (0x-hex)' }, value: { type: 'string', description: 'Wei, hex or decimal' } },
            },
          },
        },
      },
      execute: (args) => af.simulateTransaction(args),
    },
    {
      name: 'agentforge_check_signature',
      description:
        'Check a signature request BEFORE signing it: pass EIP-712 typed data (eth_signTypedData_v4 payload: ERC-20 permit, Permit2, Seaport order, transfer authorization) or an x402 PaymentRequired object. Returns what signing would allow in one sentence, who gets spending power, sanctions/scam screening of every spender and payee, drainer-pattern flags (permits to plain wallets, sell-for-nothing orders, fake USDC domains, over-priced payments), and a proceed/caution/avoid verdict. Costs $0.003 USDC.',
      parameters: {
        type: 'object',
        properties: {
          typedData: { type: 'object', description: 'EIP-712 typed data with domain, types, primaryType, message (or its JSON string)' },
          paymentRequired: { type: 'object', description: 'An x402 PaymentRequired object (with accepts[]); pass instead of typedData' },
          signer: { ...address, description: 'Wallet that would sign' },
          chain: evmChain,
          expectedMaxUsd: { type: 'number', description: 'For x402 requests: the most you expect to pay, in USD' },
        },
      },
      execute: (args) => af.checkSignature(args),
    },
    {
      name: 'agentforge_check_addresses',
      description:
        'Screen 1-100 counterparty addresses (EVM or Solana) before sending funds or granting approvals: OFAC sanctions, known scam/phishing wallets, labeled protocols, brand-new address-poisoning wallets. Returns block / caution / no_known_issues per address. Costs $0.003 + $0.001 per extra address.',
      parameters: {
        type: 'object',
        required: ['addresses'],
        properties: {
          addresses: {
            type: 'array', minItems: 1, maxItems: 100,
            items: { type: 'object', required: ['address'], properties: { address: { type: 'string' }, chain: { type: 'string', enum: [...evmChain.enum, 'solana'] } } },
          },
          chain: { type: 'string', enum: [...evmChain.enum, 'solana'], default: 'ethereum' },
        },
      },
      execute: (args) => af.checkAddresses(args),
    },
    {
      name: 'agentforge_trade_check',
      description:
        'Check a token before buying it: quantitative rug check (owner powers, holder concentration, liquidity), AI risk assessment with market data, and current gas, with a proceed/caution/avoid verdict. Costs $0.025 USDC.',
      parameters: { type: 'object', required: ['address'], properties: { address, chain: { ...evmChain, default: 'ethereum' } } },
      execute: (args) => af.tradeCheck(args),
    },
    {
      name: 'agentforge_new_launches',
      description:
        'List newly launched tokens on Base, Ethereum, Arbitrum, or BNB Chain, each already risk-scored (verification, mint/blacklist/tax powers, upgradeable proxy, supply held off-pool, honeypot trading pattern). For polling, pass the previous response\'s nextSince as since. Costs $0.005 USDC.',
      parameters: {
        type: 'object',
        properties: {
          chain: { type: 'string', enum: ['base', 'ethereum', 'arbitrum', 'bsc'], default: 'base' },
          since: { type: 'string', format: 'date-time' },
          minLiquidityUsd: { type: 'number', default: 1000 },
          maxRiskScore: { type: 'integer', minimum: 0, maximum: 100 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
        },
      },
      execute: (args) => af.launches(args),
    },
    {
      name: 'agentforge_score_tokens',
      description:
        'Rug-check a watchlist of 2-25 EVM tokens in one call: risk score, level, flags, and mint/blacklist/pause/upgrade permissions per token, riskiest first. Costs $0.004 per token.',
      parameters: {
        type: 'object', required: ['tokens'],
        properties: {
          tokens: { type: 'array', minItems: 2, maxItems: 25, items: { type: 'object', required: ['address'], properties: { address, chain: evmChain } } },
          chain: { ...evmChain, default: 'ethereum' },
        },
      },
      execute: (args) => af.scoreTokens(args),
    },
    {
      name: 'agentforge_lending_health',
      description:
        'How close a wallet is to liquidation on Aave v3 across Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain, Avalanche, Linea, and Sonic: collateral, debt, health factor, status, and how far collateral can fall before liquidation. Costs $0.003 USDC.',
      parameters: { type: 'object', required: ['address'], properties: { address, chain: { type: 'string', enum: [...evmChain.enum, 'all'], default: 'all' } } },
      execute: (args) => af.lendingHealth(args),
    },
    {
      name: 'agentforge_approval_scan',
      description: 'List risky ERC-20 approvals (unlimited allowances, unverified spenders) currently held on a wallet. Costs $0.015 USDC.',
      parameters: { type: 'object', required: ['address'], properties: { address, chain: { ...evmChain, default: 'ethereum' } } },
      execute: (args) => af.approvalScan(args),
    },
    {
      name: 'agentforge_decode_transaction',
      description: 'Explain what an EVM transaction did, in plain English: function call, parameters, token transfers. Costs $0.05 USDC.',
      parameters: { type: 'object', required: ['txHash'], properties: { txHash: { type: 'string', pattern: '^0x[a-fA-F0-9]{64}$' }, chain: { ...evmChain, default: 'ethereum' } } },
      execute: (args) => af.decodeTransaction(args),
    },
  ];
}

/** OpenAI Chat Completions / Responses `tools` shape. */
export function toOpenAITools(tools: AgentForgeTool[]) {
  return tools.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

/** Run a tool call by name (for function-calling loops). Returns a JSON string. */
export async function runAgentForgeTool(tools: AgentForgeTool[], name: string, args: unknown): Promise<string> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown AgentForge tool: ${name}`);
  const parsed = typeof args === 'string' ? JSON.parse(args) : args;
  return JSON.stringify(await tool.execute(parsed));
}
