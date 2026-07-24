// Root vitest config: main-site worker tests only. The license-worker has
// its own vitest setup (@cloudflare/vitest-pool-workers) and is run from
// license-worker/ separately.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.js"],
  },
});
