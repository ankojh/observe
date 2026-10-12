import { build as viteBuild } from 'vite';
import { build } from 'esbuild';
await viteBuild({ configFile: 'apps/extension/vite.config.ts' });
await build({ entryPoints: ['apps/extension/src/background.ts'], outfile: 'apps/extension/dist/background.js', bundle: true, format: 'esm', target: 'chrome120', minify: true });
await build({ entryPoints: ['apps/extension/src/observation/content.ts'], outfile: 'apps/extension/dist/content.js', bundle: true, format: 'iife', target: 'chrome120', minify: true });
console.log('Load unpacked: apps/extension/dist (Chrome 120+)');
