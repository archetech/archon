// The service must refuse to start without ARCHON_ADMIN_API_KEY. That is the
// primary deployment guarantee of the fail-closed admin auth change: mediators
// authenticate against Gatekeeper's admin routes with the same key, so booting
// without one would leave them silently unable to sync. A route-level test
// cannot cover this, since the process never reaches the router.

use std::{
    process::{Command, Stdio},
    thread::sleep,
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use tempfile::TempDir;

fn base_command(temp_dir: &TempDir) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_archon-rust-gatekeeper"));
    command
        // Run from the temp dir, NOT CARGO_MANIFEST_DIR: `run()` calls
        // dotenvy::dotenv(), which walks parent directories, and a developer's
        // repo-root .env would otherwise supply ARCHON_ADMIN_API_KEY and make
        // this test pass or fail depending on the machine.
        .current_dir(temp_dir.path())
        // Port 0 is never reached — startup validation runs before the bind.
        .env("ARCHON_GATEKEEPER_PORT", "0")
        .env("ARCHON_BIND_ADDRESS", "127.0.0.1")
        .env("ARCHON_GATEKEEPER_DB", "json")
        .env("ARCHON_DATA_DIR", temp_dir.path())
        .env("ARCHON_GATEKEEPER_FALLBACK_URL", "")
        .env("ARCHON_GATEKEEPER_CONFIRM_FALLBACK_URL", "")
        .env("RUST_LOG", "error")
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    command
}

fn run_and_capture(mut command: Command) -> Result<(Option<i32>, String)> {
    let mut child = command.spawn().context("failed to spawn gatekeeper")?;

    // If the guard regressed the process would serve indefinitely, so bound the
    // wait rather than hanging the suite. Polled with try_wait to avoid pulling
    // in a timeout crate for one test.
    let deadline = Instant::now() + Duration::from_secs(30);
    let code = loop {
        match child.try_wait().context("failed to poll gatekeeper")? {
            Some(status) => break status.code(),
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                anyhow::bail!("gatekeeper did not exit — it started without an admin key");
            }
            None => sleep(Duration::from_millis(50)),
        }
    };

    let mut stderr = String::new();
    if let Some(mut pipe) = child.stderr.take() {
        use std::io::Read;
        let _ = pipe.read_to_string(&mut stderr);
    }

    Ok((code, stderr))
}

#[test]
fn refuses_to_start_without_an_admin_api_key() -> Result<()> {
    let temp_dir = TempDir::new()?;
    let mut command = base_command(&temp_dir);
    command.env_remove("ARCHON_ADMIN_API_KEY");

    let (code, stderr) = run_and_capture(command)?;

    assert_eq!(code, Some(1), "expected a non-zero exit; stderr: {stderr}");
    assert!(
        stderr.contains("ARCHON_ADMIN_API_KEY must be set"),
        "expected an actionable error naming the variable, got: {stderr}"
    );
    assert!(
        stderr.contains("openssl rand -hex 32"),
        "expected the error to say how to generate a key, got: {stderr}"
    );

    Ok(())
}

#[test]
fn refuses_to_start_with_an_empty_admin_api_key() -> Result<()> {
    let temp_dir = TempDir::new()?;
    let mut command = base_command(&temp_dir);
    command.env("ARCHON_ADMIN_API_KEY", "");

    let (code, stderr) = run_and_capture(command)?;

    assert_eq!(code, Some(1), "expected a non-zero exit; stderr: {stderr}");
    assert!(
        stderr.contains("ARCHON_ADMIN_API_KEY must be set"),
        "expected an actionable error naming the variable, got: {stderr}"
    );

    Ok(())
}
