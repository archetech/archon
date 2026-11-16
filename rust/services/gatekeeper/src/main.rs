// Startup replay and imports allocate several times what the service keeps, and
// glibc's allocator holds on to that memory once it is freed: a Gatekeeper with a
// hundred thousand DIDs sat at 3.5 GB with 1 GB in use (#1642). jemalloc returns
// freed memory to the system, from a background thread so that an idle service
// gives it back too.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
#[global_allocator]
static GLOBAL: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    archon_rust_gatekeeper::run().await
}
