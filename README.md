# agentforge-tools

DeFi safety tools for AI agents, paid per call in USDC over [x402](https://x402.org) — no API keys, no accounts.

- **Preflight: is this action safe?** One call before any on-chain action: transactions simulated, signatures checked, recipients screened, tokens rug-checked → one `proceed / caution / avoid` ($0.008 + $0.004 per token)
- **Simulate a transaction before signing** — reverts, every asset leaving the wallet, approvals granted, counterparty screening → `proceed / caution / avoid` ($0.005)
- **Check a signature before signing**: decodes permits, Permit2, Seaport orders, transfer authorizations and x402 payment requests, then catches permit phishing and drainer patterns → `proceed / caution / avoid` ($0.003)
- **Screen counterparties** — OFAC sanctions, scam/phishing wallets, fresh address-poisoning wallets, 1-100 per call ($0.003 + $0.001/extra)
- **Check a token before buying** — rug-check metrics + AI risk + gas, with a verdict ($0.025)
- **New launches, already risk-scored** — Base, Ethereum, Arbitrum; poll with `since` ($0.005)
- **Batch rug checks** — 2-25 tokens per call ($0.004/token)
- **Liquidation risk** — Aave v3 on nine chains in one call ($0.003)

**Guard**: wrap a viem account, wallet client, AgentKit wallet provider or x402 client and every signature runs preflight first; `avoid` is refused before signing (see below).

Ready-made tools for **OpenAI function calling, Vercel AI SDK (`agentforge-tools/ai-sdk`), LangChain, and ElizaOS (`agentforge-tools/eliza`)**. Payments come from a Base wallet holding USDC (gasless — x402 uses signed authorizations), with a per-call spending cap.

```bash
npm install agentforge-tools
```

## Quick start

```ts
import { AgentForge } from 'agentforge-tools';

const af = new AgentForge({
  privateKey: process.env.AGENT_PRIVATE_KEY as `0x${string}`, // Base wallet with a little USDC
  maxPaymentUsd: 0.1, // refuse any single payment above $0.10
});

// One call before any on-chain action.
const check = await af.preflight({
  chain: 'base',
  from: '0xYourWallet',
  transactions: [{ to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', data: '0xa9059cbb…' }],
  recipients: ['0xRecipient'],
});
if (check.verdict === 'avoid') throw new Error(`Refusing: ${check.summary}`);

const sig = await af.checkSignature({ signer: '0xYourWallet', typedData: requestFromDapp });
if (sig.verdict === 'avoid') throw new Error(`Refusing to sign: ${sig.summary}`);

const { results } = await af.checkAddresses({ addresses: [{ address: '0xRecipient', chain: 'base' }] });
```

Already have an x402 fetch (e.g. a CDP wallet)? Pass it instead: `new AgentForge({ fetch: myPayingFetch })`.

## Guard: refuse to sign what preflight calls `avoid`

The tools above are things an agent *can* call. The Guard makes the check happen whether or not the model remembers: every transaction, signature and x402 payment the wallet produces goes through `/v1/preflight` first, and `avoid` throws before anything is signed. A prompt-injected agent can want to drain its wallet; it cannot talk the Guard out of refusing.

```ts
import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, http } from 'viem';
import { base } from 'viem/chains';
import { guardAccount, guardWalletClient, agentForgePaymentHook } from 'agentforge-tools';

const KEY = process.env.AGENT_PRIVATE_KEY as `0x${string}`;

// 1. viem account: signTransaction / signTypedData are guarded.
const account = guardAccount(privateKeyToAccount(KEY), { privateKey: KEY });

// 2. viem wallet client: sendTransaction, writeContract, signTypedData are guarded.
const wallet = guardWalletClient(createWalletClient({ account, chain: base, transport: http() }), { privateKey: KEY });

// 3. x402 client: every payment's PaymentRequired is checked (payTo sanctions, real USDC, price vs listing).
x402Client.onBeforePaymentCreation(agentForgePaymentHook({ privateKey: KEY, expectedMaxUsd: 0.1 }));
```

Coinbase AgentKit: `import { guardWalletProvider } from 'agentforge-tools/agentkit'` and wrap any EVM wallet provider before `AgentKit.from(...)`. Older x402 clients without hooks: `guardPayingFetch(payingFetch, opts)`. Claude Code / Cursor: `npx agentforge-tools hook` prints a `PreToolUse` hook that blocks tool calls carrying an unsafe transaction.

Options: `onCaution: 'allow' | 'block' | (report) => boolean` (default allow, logged), `failOpen` (default **false**: if AgentForge is unreachable the action is refused; a guard that fails open is theater), `onReport` for audit logs, `chain` when it cannot be inferred.

**Paying for checks.** Each check is $0.008. The Guard pays from prepaid credits: `privateKey` creates a `createCreditFetch` that buys a $5 pack (worth $5.75) when the balance drops under $0.50 and signs each call instead of settling it, so there is no per-call fee. Tune it with `credits: { autoTopUp: { pack: 20, whenBelowUsd: 1 } }`, or `autoTopUp: false` to fall back to per-call x402.

**Earn from your integration.** Set `credits: { referrer: '0xYourWallet' }` and you receive 10% of every credit pack your users' agents buy, for as long as they keep buying, as AgentForge credit; they get 5% extra. If you ship a plugin, framework integration or template, put your wallet there.

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
