#!/usr/bin/env node
/**
 * agentforge-tools CLI
 *
 *   npx agentforge-tools hook            Print a Claude Code / Cursor PreToolUse hook config
 *   npx agentforge-tools guard-hook      The hook itself: reads the tool call on stdin, runs
 *                                        preflight when it contains a transaction, typed data or
 *                                        an x402 PaymentRequired; exits 2 (block) on `avoid`.
 *
 * The hook pays for checks from AGENTFORGE_KEY (a Base wallet with USDC; prepaid
 * credits with auto top-up). Without the key it uses the free MCP cap? No: it
 * exits 0 with a warning, because a guard that silently fails open is theater
 * and one that blocks everything is unusable. Set the key.
 */

import { createGuard, GuardBlockedError, GuardUnavailableError } from './guard.js';
import type { Json } from './client.js';

const [, , cmd] = process.argv;

function printHookConfig(): void {
  const config = {
    hooks: {
      PreToolUse: [
        {
          matcher: '.*',
          hooks: [{ type: 'command', command: 'npx -y agentforge-tools guard-hook', timeout: 30 }],
        },
      ],
    },
  };
  console.log(`# Add to .claude/settings.json (Claude Code) or the equivalent hooks file (Cursor).
# Set AGENTFORGE_KEY in the environment to a Base wallet private key holding a little USDC.
${JSON.stringify(config, null, 2)}`);
}

/** Find something preflight can check inside an arbitrary tool input. */
export function extractAction(input: unknown): Json | undefined {
  const seen = new Set<unknown>();
  const found: Json = {};
  const walk = (v: unknown, depth: number): void => {
    if (depth > 6 || v === null || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    const o = v as Record<string, unknown>;
    if (typeof o.to === 'string' && /^0x[0-9a-fA-F]{40}$/.test(o.to) && (typeof o.data === 'string' || o.value !== undefined)) {
      const txs = (found.transactions as Json[] | undefined) ?? [];
      txs.push({ to: o.to, ...(typeof o.data === 'string' ? { data: o.data } : {}), ...(o.value !== undefined ? { value: String(o.value) } : {}) });
      found.transactions = txs;
    }
    if (o.types && o.primaryType && o.message && !found.typedData) found.typedData = o;
    if (Array.isArray(o.accepts) && (o.x402Version || o.resource) && !found.paymentRequired) found.paymentRequired = o;
    if (typeof o.from === 'string' && /^0x[0-9a-fA-F]{40}$/.test(o.from) && !found.from) found.from = o.from;
    for (const k of Object.keys(o)) walk(o[k], depth + 1);
  };
  walk(input, 0);
  if (!found.transactions && !found.typedData && !found.paymentRequired) return undefined;
  if (found.transactions && !found.from) found.from = process.env.AGENTFORGE_FROM ?? '0x0000000000000000000000000000000000000001';
  return found;
}

async function runHook(): Promise<void> {
  const raw = await new Promise<string>((resolve) => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (s += c));
    process.stdin.on('end', () => resolve(s));
  });
  let payload: { tool_input?: unknown; tool_name?: string } = {};
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  const action = extractAction(payload.tool_input);
  if (!action) process.exit(0);
  const key = process.env.AGENTFORGE_KEY as `0x${string}` | undefined;
  if (!key) {
    console.error('AgentForge guard-hook: AGENTFORGE_KEY not set; skipping the check.');
    process.exit(0);
  }
  const guard = createGuard({ privateKey: key, failOpen: process.env.AGENTFORGE_FAIL_OPEN === '1' });
  try {
    const report = await guard.check(action);
    console.error(`AgentForge: ${report.verdict}${report.reasons?.length ? ` (${report.reasons.slice(0, 2).join('; ')})` : ''}`);
    process.exit(0);
  } catch (e) {
    if (e instanceof GuardBlockedError || e instanceof GuardUnavailableError) {
      console.error(e.message);
      process.exit(2);
    }
    console.error(`AgentForge guard-hook error: ${e instanceof Error ? e.message : e}`);
    process.exit(0);
  }
}

if (cmd === 'hook') printHookConfig();
else if (cmd === 'guard-hook') await runHook();
else if (cmd !== undefined || import.meta.url === `file://${process.argv[1]}`) {
  if (cmd !== undefined) {
    console.log('Usage: agentforge-tools <hook|guard-hook>');
    process.exit(cmd ? 1 : 0);
  }
}
