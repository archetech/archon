use std::{env, net::IpAddr, path::PathBuf};

use anyhow::{Context, Result};

#[derive(Clone)]
pub(crate) struct Config {
    pub(crate) port: u16,
    pub(crate) bind_address: IpAddr,
    pub(crate) db: String,
    pub(crate) data_dir: PathBuf,
    pub(crate) ipfs_url: String,
    pub(crate) did_prefix: String,
    pub(crate) registries: Vec<String>,
    pub(crate) json_limit: usize,
    pub(crate) upload_limit: usize,
    pub(crate) gc_interval_minutes: u64,
    pub(crate) status_interval_minutes: u64,
    pub(crate) admin_api_key: String,
    pub(crate) fallback_url: String,
    pub(crate) fallback_timeout_ms: u64,
    pub(crate) max_queue_size: usize,
    pub(crate) git_commit: String,
    pub(crate) version: String,
}

impl Config {
    pub(crate) fn from_env() -> Result<Self> {
        Ok(Self {
            port: env_parse("ARCHON_GATEKEEPER_PORT", 4224)?,
            bind_address: env_parse("ARCHON_BIND_ADDRESS", IpAddr::from([0, 0, 0, 0]))?,
            db: env_var_or_default("ARCHON_GATEKEEPER_DB", "redis"),
            data_dir: PathBuf::from(env_var_or_default("ARCHON_DATA_DIR", "data")),
            ipfs_url: env_var_or_default("ARCHON_IPFS_URL", "http://localhost:5001/api/v0"),
            did_prefix: env_var_or_default("ARCHON_GATEKEEPER_DID_PREFIX", "did:cid"),
            registries: env::var("ARCHON_GATEKEEPER_REGISTRIES")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .map(|value| {
                    value
                        .split(',')
                        .map(str::trim)
                        .filter(|item| !item.is_empty())
                        .map(ToString::to_string)
                        .collect::<Vec<_>>()
                })
                .filter(|items| !items.is_empty())
                .unwrap_or_else(|| vec!["local".to_string(), "hyperswarm".to_string()]),
            json_limit: parse_size_string(&env_var_or_default("ARCHON_GATEKEEPER_JSON_LIMIT", "4mb"))?,
            upload_limit: parse_size_string(&env_var_or_default("ARCHON_GATEKEEPER_UPLOAD_LIMIT", "10mb"))?,
            gc_interval_minutes: env_parse("ARCHON_GATEKEEPER_GC_INTERVAL", 15)?,
            status_interval_minutes: env_parse("ARCHON_GATEKEEPER_STATUS_INTERVAL", 5)?,
            admin_api_key: env::var("ARCHON_ADMIN_API_KEY").unwrap_or_default(),
            fallback_url: env_var_or_default("ARCHON_GATEKEEPER_FALLBACK_URL", "https://dev.uniresolver.io"),
            fallback_timeout_ms: env_parse("ARCHON_GATEKEEPER_FALLBACK_TIMEOUT", 5000)?,
            max_queue_size: 100,
            git_commit: env::var("GIT_COMMIT").unwrap_or_else(|_| "unknown".to_string()).chars().take(7).collect(),
            version: env_var_or_default("ARCHON_GATEKEEPER_VERSION", "0.7.0"),
        })
    }
}

pub(crate) fn env_parse<T>(name: &str, default: T) -> Result<T>
where
    T: std::str::FromStr,
    T::Err: std::fmt::Display,
{
    match env::var(name) {
        Ok(value) if value.trim().is_empty() => Ok(default),
        Ok(value) => value.parse::<T>().map_err(|error| anyhow::anyhow!("{name}: {error}")),
        Err(_) => Ok(default),
    }
}

pub(crate) fn env_var_or_default(name: &str, default: &str) -> String {
    env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| default.to_string())
}

pub(crate) fn parse_size_string(value: &str) -> Result<usize> {
    let trimmed = value.trim().to_ascii_lowercase();
    let (number, multiplier) = if let Some(stripped) = trimmed.strip_suffix("mb") {
        (stripped.trim(), 1024usize * 1024usize)
    } else if let Some(stripped) = trimmed.strip_suffix("kb") {
        (stripped.trim(), 1024usize)
    } else if let Some(stripped) = trimmed.strip_suffix('b') {
        (stripped.trim(), 1usize)
    } else {
        (trimmed.as_str(), 1usize)
    };

    let parsed = number.parse::<usize>().with_context(|| format!("invalid size `{value}`"))?;
    Ok(parsed.saturating_mul(multiplier))
}
