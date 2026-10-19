import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { readFileSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const phpWasmAssetUrlPlugin = () => {
  const prefix = '\0micro-shop:php-wasm-asset-url:';
  return {
    name: 'desktop-php-wasm-asset-url',
    enforce: 'pre' as const,
    resolveId(source: string, importer?: string) {
      if (!importer || !/[\\/]@php-wasm[\\/]web-8-4[\\/]/i.test(importer) || !/\.wasm(?:\?.*)?$/i.test(source)) return null;
      return prefix + resolve(dirname(importer), source.replace(/\?.*$/, ''));
    },
    load(id: string) {
      if (!id.startsWith(prefix)) return null;
      const file = id.slice(prefix.length);
      const reference = this.emitFile({ type: 'asset', name: basename(file), source: readFileSync(file) });
      return 'export default import.meta.ROLLUP_FILE_URL_' + reference + ';';
    },
  };
};

export default defineConfig({
  root,
  publicDir: resolve(root, '../../public'),
  base: '/',
  plugins: [phpWasmAssetUrlPlugin(), vue()],
  assetsInclude: [/\.dat$/i, /\.wasm$/i, /\.so$/i, /\.la$/i],
  optimizeDeps: { exclude: ['@php-wasm/web-8-4', '@php-wasm/universal', '@wasmer/sdk'] },
  build: { outDir: 'dist', emptyOutDir: true },
});
