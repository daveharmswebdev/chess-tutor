# Incidents

An incident is anything that breaks the live app for players: it is down, a game can't be started or played, the tutor fails for everyone, or data is lost. Requirement: NFR-16 (BR-6).

The client dashboard (Epic #57) shows open incidents and those closed in the last 14 days, word for word. The client should hear about a problem from us first.

## When something breaks

1. **Confirm it** on the live app (`/api/health`, Render logs and deploy status).
2. **Open an issue right away** from the **Incident** template. It adds the `incident` label. Fill in *What happened* and *Who was affected*, even if the cause is not known yet ("cause not known yet" is a fine answer).
3. **Fix it** through the usual flow. Link the fixing PR in *What we did*, and update that section as work goes on.
4. **Close the issue** once the app works again and *What prevents a repeat* names the test, check or change (with its issue or PR link).

## How to write it

- For a non-technical client: plain words, no jargon or stack traces.
- Facts only. Say what is not known yet rather than guessing.
- No blame, and no user data (no PGN, no chat text, nothing a player typed).
- Times with a time zone.

## Rolling back a deploy

Redeploying an older commit is the fastest fix, with one trap: the game database refuses to open if its schema version is newer than the code knows (`apps/server/src/store.ts`, the `SCHEMA_VERSION` guard). So rolling back past a commit that raised `SCHEMA_VERSION` fails at startup.

So far every schema change has only added a column with a default, so older code can read and write the newer table. To roll back past one, set the version back on the Render disk before starting the older commit, for example `sqlite3 <DB_PATH> 'PRAGMA user_version = 2'` to go back past v3 (#64). Note it under *What we did*. A change that is not purely additive needs its own rollback plan, written in its PR.
