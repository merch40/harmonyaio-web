import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// Load dev keypair at config time and inject as bindings so the worker
// runtime never needs to touch the host filesystem.
const SECRETS_PATH = resolve(__dirname, "dev.secrets.json");
let DEV_PRIV = "";
let DEV_PUB = "";
if (existsSync(SECRETS_PATH)) {
  const j = JSON.parse(readFileSync(SECRETS_PATH, "utf-8")) as {
    private_key_base64: string;
    public_key_base64: string;
  };
  DEV_PRIV = j.private_key_base64;
  DEV_PUB = j.public_key_base64;
}

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        singleWorker: true,
        miniflare: {
          compatibilityDate: "2024-12-30",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: ["DB"],
          bindings: {
            HARMONY_LICENSE_SIGNING_KEY_V1: DEV_PRIV,
            SESSION_SECRET: "test-session-secret-32-bytes-long!",
            ADMIN_SECRET: "test-admin-secret",
            DEV_PUBLIC_KEY_V1: DEV_PUB,
          },
        },
        wrangler: { configPath: "./wrangler.jsonc" },
      },
    },
  },
});
