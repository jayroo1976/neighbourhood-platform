# Working agreement for Claude

You are helping **James** (UAE-based consultant, Venture Foundry) build this platform. He is direct and iterative and wants clean, finished deliverables rather than drafts. He often works from the web/phone, so deliver changes as a **zip of the whole repo** (and say what changed), and explain GUI steps rather than terminal ones where possible.

## Orientation (do this first in a new session)
1. Read `README.md`, `docs/status.md`, `docs/architecture.md`, `docs/decisions.md`.
2. Current deployment target is **James's Unraid test server** pulling a GitHub image. Azure is future and untested. Do not deploy anything to Azure or email Dubai Holding.
3. Never put real resident data, secrets or `.env` files in the repo.

## Run and verify
```bash
npm install
npm run typecheck && npm test && npm run build     # must all pass before delivering
npm run seed && npm run dev:api                    # demo data; logins printed once
```
Screenshot check: Playwright with `executablePath` of the installed Chromium; start the server with `DATABASE_URL=sqlite:/tmp/np.sqlite`. Do not run `pkill -f` patterns that match your own shell.

## DOC RULE: update all docs on every build
Every time you change code, config, infra or behaviour, in the same delivery:
1. Add an entry at the top of `CHANGELOG.md` (date, what changed, why, anything untested).
2. Update `docs/status.md` (works / tested / untested / open items / next steps).
3. Update every doc the change touches: `docs/architecture.md` (routes, tables, jobs, files), `docs/configuration.md` (any env var added/changed, plus `.env.example`), `docs/decisions.md` (new decisions with reasons), `docs/admin-guide.md`, `docs/unraid.md`, `docs/privacy-pdpl.md`, `docs/security.md`, `README.md` index.
4. Check docs against the code (routes, env vars, file names) rather than from memory.
5. Say in the reply which docs were updated.

## Guardrails (from the owner's brief and decisions)
- Data stays in the UAE for any real pilot (PDPL). AI is **off**; optional bring-your-own-key AI runs in the resident's browser only.
- Neighbours never see names or apartment numbers; admins/DH do. Photos go to DH as expiring links, not attachments.
- Management closing a case is **not** the same as fixed: only resident photo evidence (or an admin override with a note) marks it fixed.
- Scorecard wording must stay factual and show its definitions; legal review is pending.
- Keep the stack simple: Express + TypeScript API, React/Vite PWA, knex (SQLite dev, PostgreSQL deploy).
