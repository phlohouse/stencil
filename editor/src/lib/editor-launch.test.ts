import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadEditorLaunch } from './editor-launch';

const endpoint = 'http://127.0.0.1:43210/_stencil/test-token';
const yaml = `name: launch
versions:
  old:
    fields:
      patient: {cell: B2}
  new:
    extends: old
    fields:
      results: {range: A10:C20, type: table}
`;

afterEach(() => vi.unstubAllGlobals());

describe('editor launch', () => {
  it('loads a workbook and inherited schema and selects the resolved version', async () => {
    const buffer = new Uint8Array([1, 2, 3]).buffer;
    const fetch = vi.fn(async (url: string) => {
      if (url === endpoint) return new Response(JSON.stringify({ schema: true, file: 'test.xlsm', version: 'new' }));
      if (url.endsWith('/schema')) return new Response(yaml);
      return new Response(buffer);
    });
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    const launch = await loadEditorLaunch(endpoint, signal);
    expect(launch.versionIndex).toBe(1);
    expect(launch.schema?.versions[1].fields.map((field) => field.name)).toEqual(['patient', 'results']);
    expect(launch.buffer).toEqual(buffer);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch).toHaveBeenCalledWith(endpoint, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
  });

  it('reports expired launches and rejects nonlocal endpoints before fetching', async () => {
    const fetch = vi.fn(async () => new Response('', { status: 404 }));
    vi.stubGlobal('fetch', fetch);
    const signal = new AbortController().signal;
    for (const url of ['https://example.com/_stencil/token', 'http://127.0.0.1:43210/private']) {
      await expect(loadEditorLaunch(url, signal)).rejects.toThrow('Invalid local');
    }
    expect(fetch).not.toHaveBeenCalled();
    await expect(loadEditorLaunch(endpoint, signal)).rejects.toThrow('Keep stencil open running');
  });

  it('rejects a version absent from the imported schema', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url === endpoint
      ? new Response(JSON.stringify({ schema: true, file: null, version: 'missing' }))
      : new Response(yaml)));
    await expect(loadEditorLaunch(endpoint, new AbortController().signal)).rejects.toThrow('matching version is missing');
  });
});
