#[tokio::main]
async fn main() -> anyhow::Result<()> {
    archon_rust_gatekeeper::run().await
}
