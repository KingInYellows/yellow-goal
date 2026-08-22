# fixture-protected-file

Fixture repository: tracks a `.env` (materialized from `dotenv.fixture` via `__fixture-manifest.json`
— `goal-gen/.gitignore` ignores literal `.env` files repo-wide, so the safely-named source is
renamed only after materialization) and a `key.pem`, both containing obviously fake
`FIXTURE-NOT-A-SECRET` placeholder content. Used to assert that protected-path handling records only
metadata (path, size, hash) and never reads file contents.
