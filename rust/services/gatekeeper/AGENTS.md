# Rust Gatekeeper storage

- MongoDB uses the synchronous driver, which runs its own Tokio runtime. Keep entire collection operations, cursor iteration, and client initialization inside `tokio::task::block_in_place` on the service's multi-thread runtime. Wrapping only client construction does not protect later reads/writes.
- MongoDB integration tests use the `archon` database and reset it. Run them only against a disposable server, with `ARCHON_TEST_MONGODB_URL` explicitly set; env-gated tests that skip do not establish backend coverage.
