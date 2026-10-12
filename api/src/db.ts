import fs from 'node:fs';
import path from 'node:path';
import knex, { Knex } from 'knex';
import { config } from './config';
import { makeTrackingRef, normaliseCommunityCode } from './services/trackingRef';

export type Db = Knex;

export function createDb(url: string = config.databaseUrl): Db {
  if (url.startsWith('sqlite:')) {
    const filename = url.slice('sqlite:'.length);
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    return knex({
      client: 'better-sqlite3',
      connection: { filename },
      useNullAsDefault: true,
      pool: filename === ':memory:' ? { min: 1, max: 1 } : undefined,
    });
  }
  const ssl =
    config.databaseSsl === 'off'
      ? false
      : config.databaseSsl === 'no-verify'
        ? { rejectUnauthorized: false }
        : { rejectUnauthorized: true };
  return knex({
    client: 'pg',
    connection: { connectionString: url, ssl },
    pool: { min: 0, max: 10 },
  });
}

type Migration = { name: string; up: (db: Db) => Promise<void> };

// Timestamps are stored as ISO-8601 UTC strings and JSON as text so the same schema
// runs on SQLite (local dev / tests) and PostgreSQL (Azure).
const migrations: Migration[] = [
  {
    name: '001_initial',
    up: async (db) => {
      await db.schema.createTable('communities', (t) => {
        t.text('id').primary();
        t.text('name').notNullable();
        t.text('slug').notNullable().unique();
        t.text('mgmt_email').notNullable();
        t.text('mgmt_name').notNullable().defaultTo('Management company');
        t.text('towers').notNullable().defaultTo('[]');
        t.text('settings').notNullable().defaultTo('{}');
        t.text('created_at').notNullable();
      });

      await db.schema.createTable('users', (t) => {
        t.text('id').primary();
        t.text('community_id').notNullable().references('communities.id');
        t.text('email').notNullable().unique();
        t.text('password_hash').notNullable();
        t.text('name').notNullable();
        t.text('phone');
        t.text('tower');
        t.text('unit');
        t.text('role').notNullable().defaultTo('resident');
        t.integer('active').notNullable().defaultTo(1);
        t.integer('token_version').notNullable().defaultTo(0);
        t.integer('failed_logins').notNullable().defaultTo(0);
        t.text('locked_until');
        t.text('mfa_secret_enc');
        t.integer('mfa_enabled').notNullable().defaultTo(0);
        t.text('recovery_hashes').notNullable().defaultTo('[]');
        t.integer('notify_email').notNullable().defaultTo(1);
        t.text('consent_at');
        t.text('consent_version');
        t.integer('is_demo').notNullable().defaultTo(0);
        t.text('created_at').notNullable();
        t.text('last_login_at');
        t.text('deleted_at');
      });

      await db.schema.createTable('password_resets', (t) => {
        t.text('id').primary();
        t.text('user_id').notNullable().references('users.id');
        t.text('token_hash').notNullable().unique();
        t.text('expires_at').notNullable();
        t.text('used_at');
      });

      await db.schema.createTable('incidents', (t) => {
        t.text('id').primary();
        t.text('community_id').notNullable().references('communities.id');
        t.integer('seq').notNullable();
        t.text('ref').notNullable();
        t.text('reporter_id').references('users.id');
        t.text('tower');
        t.text('unit');
        t.text('title').notNullable();
        t.text('description').notNullable().defaultTo('');
        t.text('category').notNullable().defaultTo('other');
        t.text('severity').notNullable().defaultTo('normal');
        t.text('status').notNullable().defaultTo('reported');
        t.text('visibility').notNullable().defaultTo('community'); // community | private
        t.text('location_text');
        t.float('lat');
        t.float('lng');
        t.float('gps_accuracy');
        t.text('device_reported_at');
        t.text('reported_at').notNullable();
        t.text('cluster_id'); // points at the primary incident when linked
        t.text('mgmt_case_number');
        t.text('reply_token').notNullable().unique();
        t.text('emailed_at');
        t.text('case_number_at');
        t.text('mgmt_first_reply_at');
        t.text('mgmt_closed_at');
        t.integer('mgmt_closed_count').notNullable().defaultTo(0);
        t.text('resolved_at');
        t.text('resolution'); // ok | poor
        t.integer('reopen_count').notNullable().defaultTo(0);
        t.integer('reminders_sent').notNullable().defaultTo(0);
        t.integer('verify_reminders_sent').notNullable().defaultTo(0);
        t.text('last_activity_at').notNullable();
        t.text('source').notNullable().defaultTo('app'); // app | import | demo
        t.text('created_at').notNullable();
        t.text('updated_at').notNullable();
        t.unique(['community_id', 'seq']);
        t.index(['community_id', 'status']);
        t.index(['reporter_id']);
        t.index(['cluster_id']);
      });

      await db.schema.createTable('incident_events', (t) => {
        t.text('id').primary();
        t.text('incident_id').notNullable().references('incidents.id');
        t.integer('n').notNullable();
        t.text('type').notNullable();
        t.text('actor_id');
        t.text('actor_role').notNullable().defaultTo('system');
        t.integer('is_public').notNullable().defaultTo(1);
        t.text('payload').notNullable().defaultTo('{}');
        t.text('created_at').notNullable();
        t.text('prev_hash').notNullable();
        t.text('hash').notNullable();
        t.unique(['incident_id', 'n']);
      });

      await db.schema.createTable('uploads', (t) => {
        t.text('id').primary();
        t.text('user_id').notNullable().references('users.id');
        t.text('key').notNullable();
        t.text('thumb_key').notNullable();
        t.text('mime').notNullable();
        t.integer('bytes').notNullable();
        t.integer('width');
        t.integer('height');
        t.text('kind').notNullable().defaultTo('report'); // report | resolution | affects
        t.text('incident_id');
        t.text('created_at').notNullable();
        t.text('deleted_at');
        t.index(['incident_id']);
      });

      await db.schema.createTable('affects', (t) => {
        t.text('id').primary();
        t.text('incident_id').notNullable().references('incidents.id');
        t.text('user_id').notNullable().references('users.id');
        t.text('tower');
        t.text('unit');
        t.text('upload_id');
        t.text('created_at').notNullable();
        t.unique(['incident_id', 'user_id']);
      });

      await db.schema.createTable('email_outbox', (t) => {
        t.text('id').primary();
        t.text('community_id');
        t.text('incident_id');
        t.text('kind').notNullable();
        t.text('to_addr').notNullable();
        t.text('cc_addr');
        t.text('reply_to');
        t.text('subject').notNullable();
        t.text('text_body').notNullable();
        t.text('html_body');
        t.text('status').notNullable().defaultTo('queued'); // queued | sent | failed
        t.integer('attempts').notNullable().defaultTo(0);
        t.text('last_error');
        t.text('provider_id');
        t.text('created_at').notNullable();
        t.text('next_attempt_at').notNullable();
        t.text('sent_at');
        t.index(['status', 'next_attempt_at']);
      });

      await db.schema.createTable('notifications', (t) => {
        t.text('id').primary();
        t.text('user_id').notNullable().references('users.id');
        t.text('incident_id');
        t.text('type').notNullable();
        t.text('message').notNullable();
        t.text('created_at').notNullable();
        t.text('read_at');
        t.index(['user_id', 'read_at']);
      });

      await db.schema.createTable('audit_log', (t) => {
        t.text('id').primary();
        t.text('at').notNullable();
        t.text('actor_id');
        t.text('actor_role');
        t.text('action').notNullable();
        t.text('target_type');
        t.text('target_id');
        t.text('ip');
        t.text('detail').notNullable().defaultTo('{}');
        t.index(['at']);
      });
    },
  },
  {
    name: '002_affects_case_number_and_mr_towers',
    up: async (db) => {
      await db.schema.alterTable('affects', (t) => {
        t.text('mgmt_case_number');
      });
      // Rename the original demo towers to the real building names (existing data included).
      const map: Record<string, string> = { 'Tower A': 'MR 1', 'Tower B': 'MR 2', 'Tower C': 'MR 3' };
      for (const [from, to] of Object.entries(map)) {
        await db('users').where({ tower: from }).update({ tower: to });
        await db('incidents').where({ tower: from }).update({ tower: to });
        await db('affects').where({ tower: from }).update({ tower: to });
      }
      const rows = (await db('communities').select('id', 'towers')) as { id: string; towers: string }[];
      for (const c of rows) {
        let list: string[] = [];
        try {
          list = JSON.parse(c.towers);
        } catch {
          continue;
        }
        const next = list.map((t) => map[t] ?? t);
        if (JSON.stringify(next) !== JSON.stringify(list)) await db('communities').where({ id: c.id }).update({ towers: JSON.stringify(next) });
      }
    },
  },
  {
    name: '003_resident_email_and_optional_affect_photo',
    up: async (db) => {
      await db.schema.alterTable('affects', (t) => {
        t.text('email_confirmed_at');
      });
      // Photos are now recommended, not required, when adding yourself to a report.
      const rows = (await db('communities').select('id', 'settings')) as { id: string; settings: string }[];
      for (const c of rows) {
        let st: Record<string, unknown> = {};
        try {
          st = JSON.parse(c.settings || '{}');
        } catch {
          st = {};
        }
        st.require_photo_for_affects = false;
        await db('communities').where({ id: c.id }).update({ settings: JSON.stringify(st) });
      }
    },
  },
  {
    name: '004_signup_approval_and_invites',
    up: async (db) => {
      await db.schema.alterTable('users', (t) => {
        t.text('approval_status').notNullable().defaultTo('approved'); // approved | pending | rejected
        t.text('invited_by');
        t.text('invite_token');
      });
    },
  },
  {
    name: '005_terms_acceptance',
    up: async (db) => {
      await db.schema.alterTable('users', (t) => {
        t.text('terms_at');
        t.text('terms_version');
      });
    },
  },
  {
    name: '006_system_events',
    up: async (db) => {
      await db.schema.createTable('system_events', (t) => {
        t.text('id').primary();
        t.text('at').notNullable();
        t.text('kind').notNullable(); // start | update | watchtower
        t.text('title').notNullable();
        t.text('message').notNullable().defaultTo('');
        t.text('version');
        t.text('build');
        t.index(['at']);
      });
    },
  },
  {
    name: '007_approval_default_on',
    up: async (db) => {
      // Sign-ups are now approved one by one by default (no invite code). Turn it on for existing communities.
      const rows = (await db('communities').select('id', 'settings')) as { id: string; settings: string }[];
      for (const c of rows) {
        let st: Record<string, unknown> = {};
        try {
          st = JSON.parse(c.settings || '{}');
        } catch {
          st = {};
        }
        st.require_approval = true;
        await db('communities').where({ id: c.id }).update({ settings: JSON.stringify(st) });
      }
    },
  },
  {
    name: '008_tracking_refs_and_inbound_email',
    up: async (db) => {
      await db.schema.alterTable('communities', (t) => {
        t.integer('ref_seq').notNullable().defaultTo(0);
      });
      await db.schema.alterTable('incidents', (t) => {
        t.text('legacy_ref');
        t.text('closure_details');
      });
      await db.schema.alterTable('affects', (t) => {
        t.integer('seq');
        t.text('ref');
      });
      await db.schema.createTable('inbound_emails', (t) => {
        t.text('id').primary();
        t.text('community_id').notNullable().references('communities.id');
        t.text('incident_id');
        t.text('affect_id');
        t.text('status').notNullable(); // linked | review | dismissed
        t.text('route').notNullable(); // cc | forward | management_reply
        t.text('match_method'); // reference | ticket | headers | quoted_text | manual
        t.text('review_reason');
        t.text('candidate_refs'); // JSON array
        t.text('from_addr');
        t.text('from_domain');
        t.text('from_user_id');
        t.text('subject');
        t.text('snippet');
        t.text('message_id');
        t.text('in_reply_to');
        t.text('refs_header');
        t.text('auth_result'); // pass | fail | unknown
        t.text('received_at').notNullable(); // when the tracking mailbox got it (immutable)
        t.text('event_at').notNullable(); // time taken from the email itself where possible
        t.text('event_at_source').notNullable(); // original_header | forwarded_text | forward_header | declared | system
        t.text('event_at_offset'); // original offset, e.g. +04:00
        t.integer('skew_flag').notNullable().defaultTo(0);
        t.text('created_at').notNullable();
        t.index(['community_id', 'status']);
        t.index(['message_id']);
      });
      // Re-reference existing reports in the new format and keep the old reference for look-ups.
      const comms = (await db('communities').select('id', 'slug', 'settings')) as { id: string; slug: string; settings: string }[];
      for (const c of comms) {
        let st: Record<string, unknown> = {};
        try {
          st = JSON.parse(c.settings || '{}');
        } catch {
          st = {};
        }
        const code = normaliseCommunityCode(st.community_code as string | undefined, c.slug);
        st.community_code = code;
        await db('communities').where({ id: c.id }).update({ settings: JSON.stringify(st) });
        let max = 0;
        const rows = (await db('incidents').where({ community_id: c.id }).select('id', 'seq', 'ref', 'reported_at')) as { id: string; seq: number; ref: string; reported_at: string }[];
        for (const r of rows) {
          max = Math.max(max, r.seq);
          await db('incidents').where({ id: r.id }).update({ legacy_ref: r.ref, ref: makeTrackingRef(code, r.reported_at, r.seq) });
        }
        await db('communities').where({ id: c.id }).update({ ref_seq: max });
      }
      await db.schema.alterTable('affects', (t) => {
        t.index(['ref']);
      });
    },
  },
];

export async function migrate(db: Db): Promise<void> {
  const exists = await db.schema.hasTable('_migrations');
  if (!exists) {
    await db.schema.createTable('_migrations', (t) => {
      t.text('name').primary();
      t.text('applied_at').notNullable();
    });
  }
  const done = new Set((await db('_migrations').select('name')).map((r: { name: string }) => r.name));
  for (const m of migrations) {
    if (done.has(m.name)) continue;
    await m.up(db);
    await db('_migrations').insert({ name: m.name, applied_at: new Date().toISOString() });
  }
}
