import { describe, it, expect, vi } from 'vitest';
import { AgentForge, AgentForgeError, agentForgeTools, toOpenAITools, runAgentForgeTool } from '../src/index.js';
import { agentForgePlugin } from '../src/eliza.js';

function mockFetch(status = 200, body: unknown = { ok: true }) {
  return vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
}

describe('AgentForge client', () => {
  it('POSTs JSON bodies to the right endpoint', async () => {
    const f = mockFetch(200, { verdict: 'proceed' });
    const af = new AgentForge({ fetch: f as unknown as typeof fetch, baseUrl: 'https://x.test/' });
    const out = await af.simulateTransaction({ from: '0x1', transactions: [{ to: '0x2' }] });
    expect(out).toEqual({ verdict: 'proceed' });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://x.test/v1/tx-simulate');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ from: '0x1', transactions: [{ to: '0x2' }] });
  });

  it('builds query strings for GET endpoints and skips undefined values', async () => {
    const f = mockFetch();
    const af = new AgentForge({ fetch: f as unknown as typeof fetch });
    await af.launches({ chain: 'base', maxRiskScore: 40, since: undefined });
    expect(f.mock.calls[0][0]).toBe('https://agentforge-taupe.vercel.app/v1/launches?chain=base&maxRiskScore=40');
    await af.lendingHealth({ address: '0xabc' });
    expect(f.mock.calls[1][0]).toBe('https://agentforge-taupe.vercel.app/v1/lending/health?address=0xabc');
  });

  it('throws AgentForgeError with a payment hint on 402', async () => {
    const af = new AgentForge({ fetch: mockFetch(402, {}) as unknown as typeof fetch });
    const err = await af.ping().catch((e) => e);
    expect(err).toBeInstanceOf(AgentForgeError);
    expect(err.status).toBe(402);
    expect(err.message).toMatch(/privateKey/);
  });
});

describe('tool definitions', () => {
  const af = new AgentForge({ fetch: mockFetch(200, { ok: 1 }) as unknown as typeof fetch });
  const tools = agentForgeTools(af);

  it('have unique snake_case names, prices in descriptions, and object schemas', () => {
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
    for (const t of tools) {
      expect(t.name).toMatch(/^agentforge_[a-z_]+$/);
      expect(t.description).toMatch(/\$\d/);
      expect(t.parameters.type).toBe('object');
    }
  });

  it('adapt to the OpenAI tools shape and run by name', async () => {
    const openai = toOpenAITools(tools);
    expect(openai[0]).toMatchObject({ type: 'function', function: { name: 'agentforge_simulate_transaction' } });
    expect(await runAgentForgeTool(tools, 'agentforge_lending_health', '{"address":"0xabc"}')).toBe('{"ok":1}');
    await expect(runAgentForgeTool(tools, 'nope', {})).rejects.toThrow(/Unknown/);
  });
});

describe('ElizaOS plugin', () => {
  const runtime = (key?: string, modelOut: unknown = { address: '0xabc' }) => ({
    getSetting: (k: string) => (k === 'AGENTFORGE_PRIVATE_KEY' ? key ?? null : null),
    useModel: vi.fn(async () => modelOut),
  });

  it('exposes one action per tool and validates only with a key configured', async () => {
    expect(agentForgePlugin.actions).toHaveLength(8);
    const action = agentForgePlugin.actions!.find((a) => a.name === 'AGENTFORGE_LENDING_HEALTH')!;
    expect(await action.validate(runtime() as any, {} as any)).toBe(false);
    expect(await action.validate(runtime(`0x${'1'.repeat(64)}`) as any, {} as any)).toBe(true);
  });

  it('reports a clear error when the paid call fails', async () => {
    const action = agentForgePlugin.actions!.find((a) => a.name === 'AGENTFORGE_LENDING_HEALTH')!;
    const callback = vi.fn(async () => []);
    vi.stubGlobal('fetch', mockFetch(500, { error: 'down' }));
    const res = await action.handler(runtime(`0x${'2'.repeat(64)}`) as any, { content: { text: 'is 0xabc safe on aave?' } } as any, undefined, undefined, callback);
    vi.unstubAllGlobals();
    expect(res).toMatchObject({ success: false });
    expect(callback).toHaveBeenCalled();
  });
});
