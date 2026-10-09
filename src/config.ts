import crypto from 'node:crypto';

const env = process.env;
const isProd = env.NODE_ENV === 'production';
const isTest = env.NODE_ENV === 'test';

function secret(name: string, devFallback: string): string {
  const v = env[name];
  if (v && v.length >= 32) return v;
  if (isProd) {
    throw new Error(`${name} must be set to a random string of at least 32 characters in production`);
  }
  return devFallback;
}

export const config = {
  isProd,
  isTest,
  port: Number(env.PORT ?? 8080),
  appBaseUrl: (env.APP_BASE_URL ?? 'http://localhost:5173').replace(/\/$/, ''),
  timezone: 'Asia/Dubai',

  databaseUrl: env.DATABASE_URL ?? 'sqlite:./data/dev.db',
  databaseSsl: (env.DATABASE_SSL ?? (isProd ? 'require' : 'off')) as 'off' | 'require' | 'no-verify',

  jwtSecret: secret('JWT_SECRET', 'dev-only-jwt-secret-change-me-0000000000000000'),
  fileSigningSecret: secret('FILE_SIGNING_SECRET', 'dev-only-file-signing-secret-000000000000000'),
  mfaEncryptionKey: secret('MFA_ENCRYPTION_KEY', 'dev-only-mfa-encryption-key-00000000000000000'),
  sessionHours: Number(env.SESSION_HOURS ?? 12),
  cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProd,
  requireAdminMfa: env.REQUIRE_ADMIN_MFA ? env.REQUIRE_ADMIN_MFA === 'true' : isProd,

  // Pilot gate: when set, registration requires this invite code.
  registrationCode: env.REGISTRATION_CODE ?? '',

  storage: {
    provider: (env.STORAGE_PROVIDER ?? 'local') as 'local' | 'azure',
    localDir: env.STORAGE_LOCAL_DIR ?? './data/files',
    azureAccount: env.AZURE_STORAGE_ACCOUNT ?? '',
    azureContainer: env.AZURE_STORAGE_CONTAINER ?? 'incident-photos',
    azureConnectionString: env.AZURE_STORAGE_CONNECTION_STRING ?? '',
  },

  email: {
    provider: (env.EMAIL_PROVIDER ?? 'console') as 'console' | 'smtp' | 'acs',
    from: env.EMAIL_FROM ?? 'reports@neighbourhood.example',
    fromName: env.EMAIL_FROM_NAME ?? 'Neighbourhood Reports',
    smtpUrl: env.SMTP_URL ?? '',
    acsConnectionString: env.ACS_CONNECTION_STRING ?? '',
    acsEndpoint: env.ACS_ENDPOINT ?? '',
    // inbound webhook (management replies) – shared secret and the domain used for per-incident reply addresses
    inboundSecret: env.INBOUND_EMAIL_SECRET ?? '',
    replyDomain: env.REPLY_DOMAIN ?? '',
    linkTtlDays: Number(env.EMAIL_LINK_TTL_DAYS ?? 30),
  },

  ai: {
    enabled: env.AI_SUGGEST_ENABLED === 'true',
    apiKey: env.ANTHROPIC_API_KEY ?? '',
    model: env.AI_MODEL ?? 'claude-haiku-4-5-20251001',
  },

  defaults: {
    communityName: env.DEFAULT_COMMUNITY_NAME ?? 'Pilot Community',
    communitySlug: env.DEFAULT_COMMUNITY_SLUG ?? 'pilot',
    mgmtEmail: env.MGMT_EMAIL ?? 'management@example.com',
  },

  privacyNoticeVersion: '2026-10-v1',
  termsVersion: '2026-10-v1',
  schedulerEnabled: env.SCHEDULER_ENABLED ? env.SCHEDULER_ENABLED === 'true' : !isTest,
};

export function randomToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString('base64url');
}
