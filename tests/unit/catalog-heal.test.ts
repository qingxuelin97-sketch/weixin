import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  OpenAiCompatibleProvider,
  closestModel,
  resetHealCooldown,
  type ProviderConfig,
} from '../../src/llm/openai-compatible';
import * as http from '../../src/llm/http';

vi.mock('../../src/llm/http', () => ({ httpJson: vi.fn() }));
const httpJson = vi.mocked(http.httpJson);

/**
 * bad_model catalog self-heal (M-C3). Live-measured reality: Zen retires ids
 * weekly and answers 401 + "Model X is not supported" — without self-heal every
 * call fails until the user hand-pulls the list.
 */

const badModelResponse = {
  status: 401,
  data: { type: 'error', error: { type: 'ModelError', message: 'Model old-1 is not supported' } },
};
const okResponse = (text: string) => ({
  status: 200,
  data: { choices: [{ message: { content: text }, finish_reason: 'stop' }] },
});
const catalogResponse = { status: 200, data: { data: [{ id: 'new-1' }, { id: 'other-2' }] } };

function makeCfg(over: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: `prov_${Math.abs(over.id ? 0 : 0) || 'heal'}_${over.id ?? ''}`,
    kind: 'zen',
    baseUrl: 'https://gw.test/v1',
    getKey: async () => 'sk-test',
    defaultModels: ['old-1'],
    ...over,
  };
}

describe('closestModel', () => {
  it('prefers the longest shared prefix, else the first id', () => {
    expect(closestModel('deepseek-v3', ['kimi-k3', 'deepseek-v4-flash', 'glm-5'])).toBe(
      'deepseek-v4-flash',
    );
    expect(closestModel('gone', ['a', 'b'])).toBe('a');
  });
});

describe('bad_model self-heal', () => {
  beforeEach(() => {
    httpJson.mockReset();
    resetHealCooldown();
  });

  it('refreshes the catalog, retries with the closest id, and persists upward', async () => {
    const refreshed: string[][] = [];
    const p = new OpenAiCompatibleProvider(
      makeCfg({
        id: 'prov_a',
        onCatalogRefresh: (models) => refreshed.push(models),
      }),
    );
    httpJson
      .mockResolvedValueOnce(badModelResponse) // POST with stale id
      .mockResolvedValueOnce(catalogResponse) // GET /models
      .mockResolvedValueOnce(okResponse('恢复了')); // POST with healed id

    const r = await p.complete({ model: 'old-1', messages: [{ role: 'user', content: 'hi' }] });
    expect(r.text).toBe('恢复了');
    expect(refreshed).toEqual([['new-1', 'other-2']]);
    // The retry must carry a model from the fresh catalog.
    const lastBody = httpJson.mock.calls[2][0].body as { model: string };
    expect(['new-1', 'other-2']).toContain(lastBody.model);
  });

  it('does not heal on auth errors', async () => {
    const p = new OpenAiCompatibleProvider(makeCfg({ id: 'prov_b' }));
    httpJson.mockResolvedValueOnce({ status: 401, data: { error: { message: 'invalid key' } } });
    await expect(
      p.complete({ model: 'old-1', messages: [] }),
    ).rejects.toMatchObject({ kind: 'auth' });
    expect(httpJson).toHaveBeenCalledTimes(1); // no catalog fetch
  });

  it('cooldown blocks a second heal attempt (no refresh storm)', async () => {
    const p = new OpenAiCompatibleProvider(makeCfg({ id: 'prov_c' }));
    httpJson
      .mockResolvedValueOnce(badModelResponse)
      .mockResolvedValueOnce(catalogResponse)
      .mockResolvedValueOnce(okResponse('ok'));
    await p.complete({ model: 'old-1', messages: [] });

    // Second stale call within the cooldown: fails straight through, no GET.
    httpJson.mockResolvedValueOnce(badModelResponse);
    await expect(p.complete({ model: 'old-1', messages: [] })).rejects.toMatchObject({
      kind: 'bad_model',
    });
    expect(httpJson).toHaveBeenCalledTimes(4);
  });

  it('gives up cleanly when the catalog still lists the "stale" id', async () => {
    const p = new OpenAiCompatibleProvider(makeCfg({ id: 'prov_d' }));
    httpJson
      .mockResolvedValueOnce(badModelResponse)
      .mockResolvedValueOnce({ status: 200, data: { data: [{ id: 'old-1' }] } });
    await expect(p.complete({ model: 'old-1', messages: [] })).rejects.toMatchObject({
      kind: 'bad_model',
    });
  });
});
