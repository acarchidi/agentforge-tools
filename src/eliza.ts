/**
 * ElizaOS plugin: every AgentForge tool as an Eliza action.
 *
 *   import { agentForgePlugin } from 'agentforge-tools/eliza';
 *   // character.plugins: [agentForgePlugin]
 *   // settings: AGENTFORGE_PRIVATE_KEY (Base wallet with USDC), optional AGENTFORGE_MAX_PAYMENT_USD
 *
 * Arguments are extracted from the conversation with the runtime's small
 * object model against each tool's JSON Schema, then the paid call is made
 * from the configured wallet within the per-call spending cap.
 *
 * No-key alternative: connect ElizaOS's MCP plugin to
 * https://agentforge-taupe.vercel.app/mcp (free up to a daily cap).
 */

import type { Action, IAgentRuntime, Memory, Plugin } from '@elizaos/core';
import { AgentForge } from './client.js';
import { agentForgeTools, type AgentForgeTool } from './tools.js';

const clients = new WeakMap<IAgentRuntime, AgentForge>();

function clientFor(runtime: IAgentRuntime): AgentForge | null {
  const cached = clients.get(runtime);
  if (cached) return cached;
  const key = runtime.getSetting('AGENTFORGE_PRIVATE_KEY');
  if (typeof key !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(key)) return null;
  const max = Number(runtime.getSetting('AGENTFORGE_MAX_PAYMENT_USD') ?? 0.5);
  const af = new AgentForge({ privateKey: key as `0x${string}`, maxPaymentUsd: Number.isFinite(max) ? max : 0.5 });
  clients.set(runtime, af);
  return af;
}

function toAction(tool: AgentForgeTool): Action {
  return {
    name: tool.name.toUpperCase(),
    similes: [tool.name],
    description: tool.description,
    validate: async (runtime: IAgentRuntime) => clientFor(runtime) !== null,
    handler: async (runtime: IAgentRuntime, message: Memory, _state, _options, callback) => {
      const af = clientFor(runtime);
      const def = af ? agentForgeTools(af).find((t) => t.name === tool.name) : undefined;
      if (!def) return { success: false, text: 'AgentForge is not configured: set AGENTFORGE_PRIVATE_KEY.' };
      try {
        const args = await runtime.useModel('OBJECT_SMALL', {
          prompt: `Extract the arguments for the "${tool.name}" tool from this request.\nReturn only a JSON object matching this JSON Schema:\n${JSON.stringify(tool.parameters)}\n\nRequest:\n${message.content?.text ?? ''}`,
        });
        const result = await def.execute(args);
        const text = '```json\n' + JSON.stringify(result, null, 2).slice(0, 6000) + '\n```';
        await callback?.({ text, actions: [tool.name.toUpperCase()] });
        return { success: true, text, data: { result: result as Record<string, unknown> } };
      } catch (e) {
        const text = `AgentForge ${tool.name} failed: ${e instanceof Error ? e.message : String(e)}`;
        await callback?.({ text });
        return { success: false, text };
      }
    },
  };
}

/** Action list is built from the tool definitions; the client binds per runtime at call time. */
const placeholder = new AgentForge({ fetch: (() => Promise.reject(new Error('unbound'))) as typeof fetch });

export const agentForgePlugin: Plugin = {
  name: 'agentforge',
  description:
    'DeFi safety tools paid per call over x402: one-call preflight before any on-chain action, signature phishing checks and transaction simulation before signing, sanctions/scam address screening, risk-scored new launches, rug checks, liquidation risk.',
  actions: agentForgeTools(placeholder).map(toAction),
};

export default agentForgePlugin;
