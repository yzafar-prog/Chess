import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 180_000,
  use: {
    baseURL: "http://localhost:4173",
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  },
  webServer: {
    command: "npm run build && npx vite preview --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
