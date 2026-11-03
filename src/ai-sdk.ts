/**
 * Vercel AI SDK tools.
 *
 *   import { generateText } from 'ai';
 *   import { agentForgeAiSdkTools } from 'agentforge-tools/ai-sdk';
 *
 *   const { text } = await generateText({
 *     model,
 *     tools: agentForgeAiSdkTools({ privateKey: process.env.AGENT_KEY as `0x${string}` }),
 *     prompt: 'Is it safe to send 50 USDC on Base to 0x…?',
 *   });
 */

import { jsonSchema, tool, type Tool } from 'ai';
import { AgentForge, type AgentForgeOptions } from './client.js';
import { agentForgeTools } from './tools.js';

/** Every AgentForge tool as an AI SDK `tool()`, keyed by tool name. */
export function agentForgeAiSdkTools(opts: AgentForgeOptions | AgentForge = {}): Record<string, Tool> {
  const af = opts instanceof AgentForge ? opts : new AgentForge(opts);
  return Object.fromEntries(
    agentForgeTools(af).map((t) => [
      t.name,
      tool({
        description: t.description,
        inputSchema: jsonSchema(t.parameters as Parameters<typeof jsonSchema>[0]),
        execute: async (args: unknown) => t.execute(args),
      }),
    ]),
  );
}
