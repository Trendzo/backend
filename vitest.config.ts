import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

// tsconfigPaths resolves the `@/*` → `src/*` aliases (and the TS-ESM `.js`→`.ts`
// specifier rewrite) so tests can exercise modules that import via `@/...`.
export default defineConfig({
  plugins: [tsconfigPaths()],
});
