use std::collections::HashMap;

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
    }

    pub(crate) fn clear(&mut self) {
        self.histories.clear();
        self.built = false;
        self.sorted = None;
    }

    pub(crate) fn set(&mut self, did: &str, events: &[EventRecord]) {
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

    pub(crate) fn delete(&mut self, did: &str) {
        if !self.built {
            return;
        }
        self.histories.remove(&storage_key(did));
        self.sorted = None;
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
