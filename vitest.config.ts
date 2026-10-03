import { defineConfig } from "vitest/config";
import path from "path";

const templateRoot = path.resolve(import.meta.dirname);

export default defineConfig({
  root: templateRoot,
  resolve: {
    alias: {
      "@": path.resolve(templateRoot, "client", "src"),
      "@shared": path.resolve(templateRoot, "shared"),
      "@assets": path.resolve(templateRoot, "attached_assets"),
    },
  },
  test: {
    environment: "node",
    include: ["server/**/*.test.ts", "server/**/*.spec.ts"],
    // server/_core/env.ts throws at import time if JWT_SECRET is missing
    // or too short (see that file for why) — tests need a dummy value that
    // satisfies the length check, unrelated to the real production secret.
    // The roster / admin IDs / 合言葉 are env-only too (server/roster.ts).
    // Made-up names: the real roster must never be in the repository.
    env: {
      JWT_SECRET: "test-only-secret-not-used-in-production-xxxxxxxx",
      POS_MEMBERS: JSON.stringify(
        Object.fromEntries(Array.from({ length: 40 }, (_, i) => [String(3501 + i), `テスト 生徒${String(i + 1).padStart(2, "0")}`]))
      ),
      POS_ADMIN_IDS: "3509",
      POS_ACCESS_CODE: "test-access-code",
    },
  },
});
