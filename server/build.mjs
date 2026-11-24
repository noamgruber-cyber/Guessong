import { build } from 'esbuild';

// Bundle the server (and the shared workspace package) into dist/index.js.
await build({
  entryPoints: ['src/index.ts', 'src/cli/ingest.ts'],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  // @guessong/shared is TypeScript source in the workspace, so bundle it in.
  plugins: [
    {
      name: 'bundle-shared',
      setup(b) {
        b.onResolve({ filter: /^@guessong\/shared$/ }, () => ({ path: new URL('../shared/src/index.ts', import.meta.url).pathname }));
      },
    },
  ],
  sourcemap: true,
  logLevel: 'info',
});
