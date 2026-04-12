use anyhow::Result;
use prometheus::{Gauge, GaugeVec, HistogramOpts, HistogramVec, IntCounterVec, Registry};

use crate::{config::Config, AppState};

pub(crate) struct Metrics {
    pub(crate) registry: Registry,
    http_requests_total: IntCounterVec,
    http_request_duration_seconds: HistogramVec,
    pub(crate) did_operations_total: IntCounterVec,
    pub(crate) events_queue_size: GaugeVec,
    pub(crate) gatekeeper_dids_total: Gauge,
    pub(crate) gatekeeper_dids_by_type: GaugeVec,
    pub(crate) gatekeeper_dids_by_registry: GaugeVec,
    service_version_info: GaugeVec,
}

pub(crate) fn record_metrics(
    state: &AppState,
    method: &str,
    route: &str,
    status: u16,
    duration_seconds: f64,
) {
    let qualified = qualify_route(route);
    let normalized = normalize_path(&qualified);
    let status_string = status.to_string();
    state
        .metrics
        .http_requests_total
        .with_label_values(&[method, &normalized, &status_string])
        .inc();
    state
        .metrics
        .http_request_duration_seconds
        .with_label_values(&[method, &normalized, &status_string])
        .observe(duration_seconds);
}

fn qualify_route(route: &str) -> String {
    if route.starts_with("/api/") || route == "/metrics" {
        return route.to_string();
    }
    if route.starts_with('/') {
        return format!("/api/v1{route}");
    }
    format!("/api/v1/{route}")
}

pub(crate) fn normalize_path(path: &str) -> String {
    let base_path = path.split('?').next().unwrap_or(path);
    let segments = base_path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();

    if let Some(index) = segments.iter().position(|segment| *segment == "did") {
        if let Some(value) = segments.get(index + 1) {
            if value.starts_with("did:") {
                let mut normalized = segments.clone();
                normalized[index + 1] = ":did";
                return format!("/{}", normalized.join("/"));
            }
        }
    }

    if let Some(index) = segments.iter().position(|segment| *segment == "block") {
        if segments.get(index + 2) == Some(&"latest") {
            let mut normalized = segments.clone();
            if let Some(value) = normalized.get_mut(index + 1) {
                *value = ":registry";
            }
            return format!("/{}", normalized.join("/"));
        }
        if segments.get(index + 1).is_some() {
            let mut normalized = segments.clone();
            normalized[index + 1] = ":registry";
            return format!("/{}", normalized.join("/"));
        }
    }

    if let Some(index) = segments.iter().position(|segment| *segment == "queue") {
        if segments.get(index + 1).is_some() {
            let mut normalized = segments.clone();
            normalized[index + 1] = ":registry";
            return format!("/{}", normalized.join("/"));
        }
    }

    if let Some(index) = segments.iter().position(|segment| *segment == "events") {
        if segments.get(index + 1).is_some() {
            let mut normalized = segments.clone();
            normalized[index + 1] = ":registry";
            return format!("/{}", normalized.join("/"));
        }
    }

    if let Some(index) = segments.iter().position(|segment| *segment == "dids") {
        if segments.get(index + 1).is_some() {
            let mut normalized = segments.clone();
            normalized[index + 1] = ":prefix";
            return format!("/{}", normalized.join("/"));
        }
    }

    base_path.to_string()
}

impl Metrics {
    pub(crate) fn new(config: &Config) -> Result<Self> {
        let registry = Registry::new();

        let http_requests_total = IntCounterVec::new(
            prometheus::Opts::new("http_requests_total", "Total number of HTTP requests"),
            &["method", "route", "status"],
        )?;
        let http_request_duration_seconds = HistogramVec::new(
            HistogramOpts::new(
                "http_request_duration_seconds",
                "HTTP request duration in seconds",
            )
            .buckets(vec![0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0, 2.0, 5.0]),
            &["method", "route", "status"],
        )?;
        let did_operations_total = IntCounterVec::new(
            prometheus::Opts::new("did_operations_total", "Total number of DID operations"),
            &["operation", "registry", "status"],
        )?;
        let events_queue_size = GaugeVec::new(
            prometheus::Opts::new("events_queue_size", "Number of events in the queue"),
            &["registry"],
        )?;
        let gatekeeper_dids_total = Gauge::new("gatekeeper_dids_total", "Total number of DIDs")?;
        let gatekeeper_dids_by_type = GaugeVec::new(
            prometheus::Opts::new("gatekeeper_dids_by_type", "Number of DIDs by type"),
            &["type"],
        )?;
        let gatekeeper_dids_by_registry = GaugeVec::new(
            prometheus::Opts::new("gatekeeper_dids_by_registry", "Number of DIDs by registry"),
            &["registry"],
        )?;
        let service_version_info = GaugeVec::new(
            prometheus::Opts::new("service_version_info", "Service version information"),
            &["version", "commit"],
        )?;

        registry.register(Box::new(http_requests_total.clone()))?;
        registry.register(Box::new(http_request_duration_seconds.clone()))?;
        registry.register(Box::new(did_operations_total.clone()))?;
        registry.register(Box::new(events_queue_size.clone()))?;
        registry.register(Box::new(gatekeeper_dids_total.clone()))?;
        registry.register(Box::new(gatekeeper_dids_by_type.clone()))?;
        registry.register(Box::new(gatekeeper_dids_by_registry.clone()))?;
        registry.register(Box::new(service_version_info.clone()))?;

        service_version_info
            .with_label_values(&[&config.version, &config.git_commit])
            .set(1.0);
        gatekeeper_dids_total.set(0.0);

        Ok(Self {
            registry,
            http_requests_total,
            http_request_duration_seconds,
            did_operations_total,
            events_queue_size,
            gatekeeper_dids_total,
            gatekeeper_dids_by_type,
            gatekeeper_dids_by_registry,
            service_version_info,
        })
    }
}
