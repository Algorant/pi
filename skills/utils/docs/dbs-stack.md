# The database stack

Source: herdra task-15 research (sections 3, 4, 4a, 5), built by task-408. This file is the reference; the skill is the short version.

## Decided

Algorant's decisions, not open questions:

- **DuckDB by default**, one local file per project; the local file is the source of truth. A project that already has a chosen engine keeps it (p40 and codeparse DuckDB, ffsync SQLite).
- **One-way full refresh** to the homelab Postgres (`db.example.com:5432`, Postgres 18, LAN only, no TLS). No incremental mirror until a refresh takes more than a few minutes and the table has a source-side watermark.
- **Manual mirror, no timers.** `dbs mirror` runs after the project's own write step, written into that project's AGENTS.md command list. A timer needs a project whose writer is unattended and the secret-in-service design first.
- **Pilot: codeparse**, then ffsync, then p40; finanza has no database today.
- **Secret:** Proton Pass item `<project>--default--pg-password` (vault `fnox`, field `password`), exposed as `PGPASSWORD` through the project's `fnox.toml`.
- **homelab-server creates each project's database** with `~/homelab-server/tools/postgres/postgres.py create <project>` on homelab-server. `dbs bootstrap` reports whether it exists and prints that command; it does not create it.
- **Backups are out of scope** (homelab-server's nightly dump). A future agent-sessions database is excluded from that dump.
- Postgres as a project's primary database is out of scope. No data is ever written to the mirror by anything else.

## Declaration: `dbs.toml`

```toml
project = "codeparse"            # database AND role name; lowercase slug [a-z][a-z0-9_]*
# host = "db.example.com"          # default
# port = 5432                    # default

[[source]]
name   = "codes"                 # unique in the project
engine = "duckdb"                # duckdb | sqlite
path   = "data/codes.duckdb"     # relative to the project root
# schema  = "public"             # default for the first source; later sources must set their own, unique per source
# exclude = ["scratch_table"]    # tables to skip
```

`dbs` reads a strict subset: double-quoted strings without `#` or backslashes, an integer `port`, a string list for `exclude`. Anything else fails naming the line. Run `dbs` from the project root. Only the source's `main` schema is mirrored. Table and primary-key column names must be plain identifiers (`[A-Za-z_][A-Za-z0-9_]*`); otherwise the run stops and names the table (rename it or exclude it).

## Credentials

1. homelab-server runs `postgres.py create <project>` on homelab-server: the role and database `<project>`, owner-only, with a generated password in `~/homelab-server/.secrets/postgres/roles/<project>.password` (mode 0600, **ends with a newline**).
2. Algorant runs the reviewed Scriptify script `agent/skills/utils/scripts/store-pg-password.sh <project>`. It reads that file over ssh into a shell variable, strips the newline (`tr -d '\n'`; command substitution does too, but anything that pipes raw bytes must strip it explicitly), and writes the Proton item through a JSON login template on `pass-cli`'s stdin. No echo, no argv, no file. Rerun-safe: an identical item is left alone; a different value (after `postgres.py rotate`) replaces it after confirmation, with the old item restored from the Proton trash if the write fails. `DBS_STORE_DRY_RUN=1` walks the flow and writes nothing.
3. Only after the item exists (step 2), the project's `fnox.toml` gets the reference. Adding it first breaks every fnox command in the project when `if_missing = "error"`:

   ```toml
   [secrets.PGPASSWORD]
   provider = "proton"
   value    = "<project>--default--pg-password"
   ```

   Run `fnox exec -- dbs mirror`. libpq, `psql` and DuckDB's postgres extension all read `PGPASSWORD`. `dbs` refuses to run without it (except a source-only `mirror --dry-run`) and says how to inject it.

Agents never see the value. Rotation is homelab-server's `postgres.py rotate <project>` followed by the same script.

## The mirror (`dbs mirror`)

One `duckdb` CLI run per source: the source is attached `READ_ONLY` (the local file is never written), the Postgres database is attached through the `postgres` extension (plus `sqlite` for a SQLite source; both are `INSTALL`ed on first use and again after a CLI upgrade, which needs internet once). In **one Postgres transaction**:

1. `CREATE SCHEMA IF NOT EXISTS` (non-`public` schemas).
2. For each source base table: `CREATE OR REPLACE TABLE pg.<schema>.<t> AS SELECT * FROM src.main.<t>`, then `ALTER TABLE ... ADD PRIMARY KEY (...)` from the source's `PRIMARY KEY` constraints (both engines).
3. `DROP TABLE` for every table in the mirror schema that is not a mirrored source table (tables dropped or excluded in the source), except `_mirror_*`.
4. Insert one `<schema>._mirror_runs` row (`finished_at` is the start of the run by the local clock, so `status` compares like clocks with the file's mtime; `seconds`; `source` engine; `tables` jsonb of Postgres-side row counts) and `COMMENT ON SCHEMA` ("one-way mirror of <path>; overwritten by dbs mirror").
5. `COMMIT`.

A failed or interrupted run never reaches `COMMIT`, so the previous mirror stays intact (observed: a later table failing its primary key rolled back an earlier table's replacement). Everything in a mirror schema except `_mirror_*` belongs to `dbs`.

Not mirrored: views, foreign keys, secondary indexes, defaults, sequences, CHECK constraints. Add indexes in Postgres only when a reader needs them. Keep views and any object that depends on a mirrored table in a different schema: `CREATE OR REPLACE`/`DROP` of a table that something depends on (or a non-table object in the mirror schema) fails the run, which rolls back, and `dbs` says so. Replacing holds locks until `COMMIT`, so readers of a table being replaced wait.

Type mapping (observed): `VARCHAR`, `INTEGER`, `BIGINT`, `DOUBLE`, `BOOLEAN`, `DATE` keep their kind; DuckDB `TIMESTAMP` becomes `timestamp without time zone` (naive UTC); `DECIMAL(p,s)` becomes `numeric(p,s)`; DuckDB `JSON` becomes `json` (alter to `jsonb` in Postgres if needed); SQLite `INTEGER`/`TEXT`/`REAL` become `bigint`/`character varying`/`double precision`, and its text dates and JSON stay text.

## Commands

All run from the project root; output is names, counts, sizes and ages. Exit 0 ok, 1 stale or mismatch, 2 usage or environment error (every such message ends with a `next:` step).

- `dbs bootstrap`: checks `dbs.toml`, the source files, the duckdb CLI, extensions, whether the CLI is at least as new as each DuckDB file's writer, direct reachability, the database and role (`ssh homelab-server postgres.py list`), and the `fnox.toml` reference. Prints the exact next step for anything missing, including the `postgres.py create` command and the Proton script. Never reads a password.
- `dbs mirror [--source N] [--via-ssh] [--dry-run]`: as above. `--dry-run` attaches both sides, lists tables, row counts, primary keys and tables that would be dropped, and writes nothing. Without `PGPASSWORD` it attaches the source only, lists tables, counts and keys (and runs the CLI-version check), and says the Postgres check was skipped.
- `dbs status [--source N]`: per source, local size and age, table counts matching, last `_mirror_runs` row (age, seconds), and fresh or stale (source or its `-wal` modified after the last run, a count mismatch, or a table set difference; exit 1 when stale). `status` needs Postgres: with a wrong or missing password it does not report stale but exits 2 with the wrong-password cause and its `next:` step, like every other command.
- `dbs verify [--source N] [--deep]`: per-table counts; `--deep` also counts rows only in the source and only in the mirror (`EXCEPT ALL`, both directions). Exit 1 on any difference.
- `dbs sql [--local] [--source N] [--csv] "<query>"`: read-only (`select`, `with`, `from`, `describe`, `show`, `summarize`, `explain`); both databases are attached `READ_ONLY` and external file access is off. Unqualified table names resolve in the mirror schema (or the source's `main` with `--local`). This is the one command that prints data values: they are the result.

## Reaching Postgres

Postgres publishes on the LAN address only. On the LAN, `dbs` connects directly. Otherwise it refuses and names `--via-ssh`, which opens `ssh -M -f -N -L 127.0.0.1:<random port>:<host>:<port> $DBS_SSH_HOST` (default `homelab-server`, BatchMode) for the run and closes it afterwards. Every pg-using command accepts it. There is no automatic fallback.

## Failures

`dbs` never prints the raw DuckDB error (it can carry connection details or data values). It prints the phase, the stage (`table <name>`, `drop <name>`, `commit`), a one-line cause from a fixed list (wrong password, missing database or role, unreachable Postgres, locked source file, CLI too old or too new, extension download failed, dependent object in the mirror schema, primary key could not be created, permission denied) with the next step, and the path of a 0600 log `${TMPDIR:-/tmp}/dbs-<project>-error.log` holding the raw text. The log stays until the next failure overwrites it or the next successful `mirror` (not `--dry-run`) removes it; `status`, `verify`, `sql` and `bootstrap` never delete it.

## The duckdb CLI

Every machine that runs `dbs` has the distribution's `duckdb` CLI (Arch `extra`; workstation and laptop via the algomarchy package list, homelab-server already). The CLI must be at least as new as the newest DuckDB that writes a project's file (older DuckDB cannot read a newer storage format). `dbs` reads the writer version from the file header and fails with the upgrade step otherwise. Projects whose own code uses DuckDB (p40 from Python via uv) keep their own dependency. `DBS_DUCKDB` overrides the CLI path.

## When the mirror runs

| Project | Write step | Mirror |
| --- | --- | --- |
| codeparse | `fnox exec -- uv run codeparse import sheet --apply` (and `import prune --apply`) | `fnox exec -- dbs mirror` right after |
| ffsync | `just sync` | a line after `npm run sync:all` in the recipe; reading the live WAL file is fine |
| p40 | receiving session ends, or `health ingest` | by hand, once no ingest runs (a held DuckDB lock fails clearly) |

`dbs status` is the freshness check; the mirror failing never fails the project's own command.

## Out of scope

Backups (homelab-server), `postgres.py rotate/drop` (homelab-server), importing data into the local file (each project's pipeline), a read-only Postgres role, encryption, an incremental mirror.
