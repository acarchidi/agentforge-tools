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

const evmChain = { type: 'string', enum: ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon'] };
const address = { type: 'string', pattern: '^0x[a-fA-F0-9]{40}$' };

export function agentForgeTools(af: AgentForge): AgentForgeTool[] {
  return [
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
      parameters: { type: 'object', required: ['address'], properties: { address, chain: { type: 'string', enum: ['ethereum', 'base', 'polygon', 'arbitrum'], default: 'ethereum' } } },
      execute: (args) => af.tradeCheck(args),
    },
    {
      name: 'agentforge_new_launches',
      description:
        'List newly launched tokens on Base, Ethereum, or Arbitrum, each already risk-scored (verification, mint/blacklist/tax powers, upgradeable proxy, supply held off-pool, honeypot trading pattern). For polling, pass the previous response\'s nextSince as since. Costs $0.005 USDC.',
      parameters: {
        type: 'object',
        properties: {
          chain: { type: 'string', enum: ['base', 'ethereum', 'arbitrum'], default: 'base' },
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
        'How close a wallet is to liquidation on Aave v3 across Ethereum, Base, Arbitrum, Optimism, and Polygon: collateral, debt, health factor, status, and how far collateral can fall before liquidation. Costs $0.003 USDC.',
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
