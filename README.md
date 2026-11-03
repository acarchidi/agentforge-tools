# agentforge-tools

DeFi safety tools for AI agents, paid per call in USDC over [x402](https://x402.org) — no API keys, no accounts.

- **Simulate a transaction before signing** — reverts, every asset leaving the wallet, approvals granted, counterparty screening → `proceed / caution / avoid` ($0.005)
- **Screen counterparties** — OFAC sanctions, scam/phishing wallets, fresh address-poisoning wallets, 1-100 per call ($0.003 + $0.001/extra)
- **Check a token before buying** — rug-check metrics + AI risk + gas, with a verdict ($0.025)
- **New launches, already risk-scored** — Base, Ethereum, Arbitrum; poll with `since` ($0.005)
- **Batch rug checks** — 2-25 tokens per call ($0.004/token)
- **Liquidation risk** — Aave v3 on five chains in one call ($0.003)

Ready-made tools for **OpenAI function calling, Vercel AI SDK (`agentforge-tools/ai-sdk`), LangChain, and ElizaOS (`agentforge-tools/eliza`)**. Payments come from a Base wallet holding USDC (gasless — x402 uses signed authorizations), with a per-call spending cap.

```bash
npm install github:acarchidi/agentforge-tools
```

## Quick start

```ts
import { AgentForge } from 'agentforge-tools';

const af = new AgentForge({
  privateKey: process.env.AGENT_PRIVATE_KEY as `0x${string}`, // Base wallet with a little USDC
  maxPaymentUsd: 0.1, // refuse any single payment above $0.10
});

const sim = await af.simulateTransaction({
  chain: 'base',
  from: '0xYourWallet',
  transactions: [{ to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', data: '0xa9059cbb…' }],
});
if (sim.verdict === 'avoid') throw new Error(`Refusing to sign: ${sim.reasons}`);

const { results } = await af.checkAddresses({ addresses: [{ address: '0xRecipient', chain: 'base' }] });
```

Already have an x402 fetch (e.g. a CDP wallet)? Pass it instead: `new AgentForge({ fetch: myPayingFetch })`.

## OpenAI function calling

```ts
import OpenAI from 'openai';
import { AgentForge, agentForgeTools, toOpenAITools, runAgentForgeTool } from 'agentforge-tools';

const tools = agentForgeTools(new AgentForge({ privateKey: KEY }));
const res = await new OpenAI().chat.completions.create({ model, messages, tools: toOpenAITools(tools) });
for (const call of res.choices[0].message.tool_calls ?? []) {
  const output = await runAgentForgeTool(tools, call.function.name, call.function.arguments);
  messages.push({ role: 'tool', tool_call_id: call.id, content: output });
}
```

## Vercel AI SDK

```ts
import { generateText } from 'ai';
import { agentForgeAiSdkTools } from 'agentforge-tools/ai-sdk';

const { text } = await generateText({
  model,
  tools: agentForgeAiSdkTools({ privateKey: process.env.AGENT_KEY as `0x${string}`, maxPaymentUsd: 0.1 }),
  prompt: 'Simulate sending 50 USDC on Base from 0xMyWallet to 0xRecipient. Is it safe?',
});
```

## LangChain (JS)

```ts
import { DynamicStructuredTool } from '@langchain/core/tools';
import { AgentForge, agentForgeTools } from 'agentforge-tools';

const tools = agentForgeTools(new AgentForge({ privateKey: KEY })).map(
  (t) => new DynamicStructuredTool({ name: t.name, description: t.description, schema: t.parameters as any,
    func: async (args) => JSON.stringify(await t.execute(args)) }),
);
```

## ElizaOS

```ts
import { agentForgePlugin } from 'agentforge-tools/eliza';
// character: plugins: [agentForgePlugin]
// settings.secrets: AGENTFORGE_PRIVATE_KEY, optional AGENTFORGE_MAX_PAYMENT_USD (default 0.5)
```

## No wallet? Use MCP (free up to a daily cap)

Every tool is also an MCP server at `https://agentforge-taupe.vercel.app/mcp` (Streamable HTTP, no auth; listed in the official MCP Registry as `io.github.acarchidi/agentforge`).

```bash
claude mcp add --transport http agentforge https://agentforge-taupe.vercel.app/mcp
```

Cursor / Windsurf / Claude Desktop / ElizaOS MCP plugin: add an HTTP MCP server with the same URL.

## Links

- Service: https://agentforge-taupe.vercel.app — [catalog](https://agentforge-taupe.vercel.app/catalog), [OpenAPI](https://agentforge-taupe.vercel.app/openapi.json), [x402 manifest](https://agentforge-taupe.vercel.app/.well-known/x402), [llms.txt](https://agentforge-taupe.vercel.app/llms.txt)
- Every paid endpoint answers an unpaid request with HTTP 402 and its exact price; failed calls (4xx/5xx) are never charged.

MIT licensed.
