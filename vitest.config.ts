import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    pool: 'forks',
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'sqlite::memory:',
      INBOUND_EMAIL_SECRET: 'test-inbound-secret',
      REPLY_DOMAIN: 'reply.test',
      REQUIRE_ADMIN_MFA: 'false',
      MGMT_EMAIL: 'community-support@mgmt.test',
      APP_BASE_URL: 'https://app.test',
    },
    testTimeout: 30_000,
  },
});
