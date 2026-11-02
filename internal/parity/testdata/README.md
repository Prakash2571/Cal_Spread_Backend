# Frozen migration reference

`kept-suites.json` records the original retained Node test titles and SHA-256 of
each source file at the pinned pre-migration commit. `routes.json` and
`shutdown.json` preserve the non-Box route and shutdown contracts independently
of the retired TypeScript source. The Go parity tests verify this metadata and
the audit's Go test references.

These are migration specifications, not runnable Node application code. Existing
feature-package JSON goldens remain the numerical/wire reference for their tests.

`goldens.sha256` pins all 39 retained JSON fixtures, byte-for-byte, to verified reference
checkpoint `8de7ca5`. `TestRetainedGoldenIntegrity` checks every digest without Node or Git.
See `docs/REFERENCE_PROVENANCE.md` for original source and generator recovery from Git history.
