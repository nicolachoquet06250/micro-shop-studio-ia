// @ts-check
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import vue from '@astrojs/vue';
import { readFile } from 'node:fs/promises';
import path from 'node:path';


/**
 * PHP.wasm's Emscripten loader imports its `.wasm` binary as a default URL.
 * Vite 8/Rolldown interprets bare `.wasm` imports as WebAssembly modules.
 * Redirect only PHP 8.4's binary import to a virtual JS module which emits
 * the binary as a normal asset and default-exports the final asset URL.
 */
function phpWasmAssetUrlPlugin() {
  const virtualPrefix = '\0micro-shop:php-wasm-asset-url:';
  const phpWasmImporter = /[\\/]@php-wasm[\\/]web-8-4[\\/]/i;
  const wasmImport = /\.wasm(?:\?.*)?$/i;

  return {
    name: 'micro-shop:php-wasm-asset-url',
    enforce: 'pre',

    resolveId(source, importer) {
      if (!importer || !phpWasmImporter.test(importer) || !wasmImport.test(source)) {
        return null;
      }

      const cleanSource = source.replace(/\?.*$/, '');
      const absolutePath = path.resolve(path.dirname(importer), cleanSource);
      return `${virtualPrefix}${absolutePath}`;
    },

    async load(id) {
      if (!id.startsWith(virtualPrefix)) return null;

      const absolutePath = id.slice(virtualPrefix.length);
      const source = await readFile(absolutePath);
      const referenceId = this.emitFile({
        type: 'asset',
        name: path.basename(absolutePath),
        source,
      });

      return `export default import.meta.ROLLUP_FILE_URL_${referenceId};`;
    },
  };
}

const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  output: 'server',
  adapter: node({
    mode: 'standalone',
  }),
  integrations: [vue({ appEntrypoint: '/src/vue-app' })],
  vite: {
    plugins: [phpWasmAssetUrlPlugin()],
    assetsInclude: [/\.dat$/i, /\.wasm$/i, /\.so$/i, /\.la$/i],
    optimizeDeps: {
      exclude: ['@php-wasm/web-8-4', '@php-wasm/universal', '@wasmer/sdk'],
    },
    server: { headers: isolationHeaders },
    preview: { headers: isolationHeaders },
  },
});
