import { parseYaml } from './yaml-export';
import type { StencilSchema } from './types';

export async function loadEditorLaunch(url: string, signal: AbortSignal): Promise<{
  schema: StencilSchema | null;
  versionIndex: number;
  buffer: ArrayBuffer | null;
}> {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1'
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || !/^\/_stencil\/[A-Za-z0-9_-]+$/.test(endpoint.pathname)) {
    throw new Error('Invalid local editor launch URL');
  }
  const read = async (path: string) => {
    const response = await fetch(`${endpoint.href}${path}`, {
      signal, credentials: 'omit', referrerPolicy: 'no-referrer',
    });
    if (!response.ok) throw new Error('Could not load launch files. Keep stencil open running and retry.');
    return response;
  };
  const manifest = await (await read('')).json();
  if (typeof manifest.schema !== 'boolean'
    || !(manifest.file === null || typeof manifest.file === 'string')
    || !(manifest.version === null || typeof manifest.version === 'string')) {
    throw new Error('Invalid editor launch manifest');
  }
  const [schema, buffer] = await Promise.all([
    manifest.schema ? read('/schema').then((response) => response.text()).then(parseYaml) : null,
    manifest.file ? read('/file').then((response) => response.arrayBuffer()) : null,
  ]);
  const versionIndex = schema && manifest.version !== null
    ? schema.versions.findIndex((version) => version.discriminatorValue === manifest.version)
    : 0;
  if (versionIndex < 0) throw new Error('The matching version is missing from the schema');
  return { schema, versionIndex, buffer };
}
