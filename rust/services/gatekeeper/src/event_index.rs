use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::store::EventRecord;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct EventSummary {
    // The storage key: the DID without its prefix.
    pub(crate) key: String,
    // Index of the event in the DID's accepted history.
    pub(crate) position: usize,
    pub(crate) time: Option<i64>,
    pub(crate) registry: String,
}

pub(crate) struct EventQuery<'a> {
    pub(crate) after: Option<i64>,
    pub(crate) before: Option<i64>,
    pub(crate) registry: Option<&'a str>,
    pub(crate) limit: usize,
    pub(crate) offset: usize,
}

/// Accepted events across all DIDs, kept in step with the histories written
/// to the store so a page of recent events costs no scan of the whole store.
/// Only summaries are held; callers read the listed events from the store.
/// Histories are keyed like the store keys them, by DID suffix.
#[derive(Default)]
pub(crate) struct EventIndex {
    histories: HashMap<String, Vec<EventSummary>>,
    sorted: Option<Vec<EventSummary>>,
    built: bool,
    // Every write to an accepted history passes through this index, so the log
    // of which DIDs changed is kept here, by the same writes.
    pub(crate) changes: ChangeLog,
}

pub(crate) struct ChangePage {
    pub(crate) epoch: String,
    // The sequence of the latest change.
    pub(crate) sequence: u64,
    // Storage keys in ascending sequence, each once, at its latest change.
    pub(crate) changes: Vec<(String, u64)>,
}

/// Which DIDs' accepted histories have changed, in the order this node changed
/// them. A reader that asks what has changed since it last looked can follow a
/// node at the cost of what changed, without reading every event again.
///
/// The numbers are this node's own, counted from one build of its histories.
/// They are not event times, which follow a block or a signer and not arrival,
/// and they mean nothing on another node or after a restart: the epoch names
/// the run they belong to, and a reader that meets a new epoch reads
/// everything again.
pub(crate) struct ChangeLog {
    epoch: String,
    sequence: u64,
    // The latest change to each DID, and every change in order. An entry in the
    // log that is not its DID's latest is passed over, and removed when the log
    // is next compacted.
    latest: HashMap<String, u64>,
    log: Vec<(String, u64)>,
}

impl Default for ChangeLog {
    fn default() -> Self {
        Self {
            epoch: new_epoch(),
            sequence: 0,
            latest: HashMap::new(),
            log: Vec::new(),
        }
    }
}

impl ChangeLog {
    /// Everything may have changed: the histories were built or cleared.
    pub(crate) fn reset(&mut self) {
        *self = Self::default();
    }

    /// The sequence of the latest change.
    pub(crate) fn sequence(&self) -> u64 {
        self.sequence
    }

    pub(crate) fn record(&mut self, key: &str) {
        self.sequence += 1;
        self.latest.insert(key.to_string(), self.sequence);

        // A run of writes to one DID, as an import of its history is, keeps the
        // one entry: a reader is not made to pass over the run to reach it.
        if let Some(last) = self.log.last_mut() {
            if last.0 == key {
                last.1 = self.sequence;
                return;
            }
        }

        self.log.push((key.to_string(), self.sequence));

        if self.log.len() > 2 * self.latest.len() + 1024 {
            let latest = &self.latest;
            self.log
                .retain(|(key, sequence)| latest.get(key) == Some(sequence));
        }
    }

    /// The changes after a sequence, oldest first, up to a limit. With no
    /// sequence, none: only where the log now stands.
    pub(crate) fn since(&self, sequence: Option<u64>, limit: usize) -> ChangePage {
        let changes = match sequence {
            None => Vec::new(),
            Some(since) => {
                // The log is in ascending sequence: find the first entry after it.
                let start = self.log.partition_point(|(_, sequence)| *sequence <= since);
                self.log[start..]
                    .iter()
                    .filter(|(key, sequence)| self.latest.get(key) == Some(sequence))
                    .take(limit)
                    .cloned()
                    .collect()
            }
        };
        ChangePage {
            epoch: self.epoch.clone(),
            sequence: self.sequence,
            changes,
        }
    }
}

// Unique to a build of the histories: the time, the process and a count, since
// a process can build more than once.
fn new_epoch() -> String {
    static BUILDS: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    format!(
        "{nanos:x}-{:x}-{:x}",
        std::process::id(),
        BUILDS.fetch_add(1, Ordering::Relaxed)
    )
}

impl EventIndex {
    /// Writes before the first build are ignored: the build reads everything.
    pub(crate) fn is_built(&self) -> bool {
        self.built
    }

    pub(crate) fn build<'a>(
        &mut self,
        histories: impl IntoIterator<Item = (&'a String, &'a Vec<EventRecord>)>,
    ) {
        self.histories.clear();
        for (did, events) in histories {
            let key = storage_key(did);
            if !events.is_empty() {
                self.histories.insert(key.clone(), summarize(&key, events));
            }
        }
        self.built = true;
        self.sorted = None;
        self.changes.reset();
    }

    pub(crate) fn clear(&mut self) {
        self.histories.clear();
        self.built = false;
        self.sorted = None;
        self.changes.reset();
    }

    /// Takes a history that was written: the index follows it, and the DID is
    /// recorded as changed.
    pub(crate) fn set(&mut self, did: &str, events: &[EventRecord]) {
        if !self.built {
            return;
        }
        self.refresh(did, events);
        self.changes.record(&storage_key(did));
    }

    /// Takes a history as it now stands, whether or not it was written. The
    /// caller records a change if there was one.
    pub(crate) fn refresh(&mut self, did: &str, events: &[EventRecord]) {
        if !self.built {
            return;
        }
        let key = storage_key(did);
        if events.is_empty() {
            self.histories.remove(&key);
        } else {
            self.histories.insert(key.clone(), summarize(&key, events));
        }
        self.sorted = None;
    }

    /// How many events the index holds for a DID.
    pub(crate) fn len_of(&self, did: &str) -> usize {
        self.histories.get(&storage_key(did)).map_or(0, Vec::len)
    }

    /// Records a DID as changed.
    pub(crate) fn record(&mut self, did: &str) {
        if self.built {
            self.changes.record(&storage_key(did));
        }
    }

    pub(crate) fn delete(&mut self, did: &str) {
        if !self.built {
            return;
        }
        let key = storage_key(did);
        self.histories.remove(&key);
        self.sorted = None;
        self.changes.record(&key);
    }

    pub(crate) fn query(&mut self, query: &EventQuery<'_>) -> (usize, Vec<EventSummary>) {
        let sorted = self.sorted.get_or_insert_with(|| {
            let mut all: Vec<_> = self
                .histories
                .values()
                .flatten()
                .filter(|entry| entry.time.is_some())
                .cloned()
                .collect();
            all.sort_by(compare_summaries);
            all
        });
        let matching: Vec<_> = sorted
            .iter()
            .filter(|entry| {
                let time = entry.time.expect("indexed events have times");
                query.after.is_none_or(|after| time > after)
                    && query.before.is_none_or(|before| time < before)
                    && query
                        .registry
                        .is_none_or(|registry| entry.registry == registry)
            })
            .collect();
        let page = matching
            .iter()
            .skip(query.offset)
            .take(query.limit)
            .map(|entry| (*entry).clone())
            .collect();
        (matching.len(), page)
    }
}

/// Event times compare as the millisecond instants the resolver uses.
pub(crate) fn event_time_millis(time: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(time)
        .ok()
        .map(|time| time.timestamp_millis())
}

// Newest first. Ties fall back to the storage key and then to the later
// position in a history, so every node orders the same events the same way.
fn compare_summaries(a: &EventSummary, b: &EventSummary) -> std::cmp::Ordering {
    b.time
        .cmp(&a.time)
        .then_with(|| a.key.cmp(&b.key))
        .then_with(|| b.position.cmp(&a.position))
}

fn summarize(key: &str, events: &[EventRecord]) -> Vec<EventSummary> {
    events
        .iter()
        .enumerate()
        .map(|(position, event)| EventSummary {
            key: key.to_string(),
            position,
            time: event_time_millis(&event.time),
            registry: event.registry.clone(),
        })
        .collect()
}

fn storage_key(did: &str) -> String {
    did.rsplit(':').next().unwrap_or(did).to_string()
}
