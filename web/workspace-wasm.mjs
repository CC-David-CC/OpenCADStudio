// SPDX-License-Identifier: GPL-3.0-or-later

export async function workspaceWasm(path, integrity) {
  const response = await fetch(new URL(path, import.meta.url), {integrity});
  if (!response.ok || !response.body) throw Error('Could not load the CAD engine.');
  return new Response(response.body.pipeThrough(new DecompressionStream('gzip')), {
    headers: {'Content-Type': 'application/wasm'},
  });
}
