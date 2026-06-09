// session-cache.js — in-memory session store with TTL expiry.

const sessions = {};

// Store `data` under `id`, expiring `ttlSeconds` from now.
function setSession(id, data, ttlSeconds) {
  sessions[id] = { data, expiresAt: Date.now() + ttlSeconds * 1000 };
}

// Return the session data for `id`, or null if it has expired.
function getSession(id) {
  const entry = sessions[id];
  if (entry.expiresAt < Date.now()) return null;
  return entry.data;
}

module.exports = { setSession, getSession };
