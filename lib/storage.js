// chrome.storage.local wrapper.
//
// Storage layout (all values JSON-serializable so we can dump-to-file later):
//
//   rules                      Rule[]                    — per-context config (step 5)
//   currentSessions            { [tabId]: Session }      — in-flight sessions, mirror of SW memory
//   sessions:YYYY-MM-DD        Session[]                 — completed sessions, bucketed by local day
//
// Why date-bucket completed sessions: lets the popup load just today and
// the dashboard load a date range, instead of reading years of history on
// every read. Also makes manual export trivial — one date is one key is one
// JSON blob you can copy out of devtools → Application → Storage.
//
// Loaded by SW via importScripts. Not used in content scripts (they have
// no storage needs of their own).

async function sgGet(key, fallback) {
  const obj = await chrome.storage.local.get(key);
  return obj[key] === undefined ? fallback : obj[key];
}

async function sgSet(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

// Read-modify-write helper. Not atomic across SW restarts, but chrome.storage
// serializes calls within a single SW instance, so back-to-back updates from
// the same SW won't race. If we ever need cross-context atomicity we'll add
// a queue here.
async function sgUpdate(key, fallback, fn) {
  const cur = await sgGet(key, fallback);
  const next = fn(cur);
  await sgSet(key, next);
  return next;
}

// Delete a key from storage. Used for one-shot migrations (e.g. dropping the
// v1 `bucketActiveMs` key on SW startup) and for any future cleanup needs.
async function sgRemove(key) {
  await chrome.storage.local.remove(key);
}

// Local-time day key. Using local time (not UTC) because "daily" reset and
// the dashboard's per-day buckets should match the calendar day the user
// sees on their wall, not a server somewhere.
function sgDateKey(ts = Date.now()) {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `sessions:${yyyy}-${mm}-${dd}`;
}

self.SGStorage = {
  get: sgGet,
  set: sgSet,
  update: sgUpdate,
  remove: sgRemove,
  dateKey: sgDateKey,
};
