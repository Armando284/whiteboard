'use strict';

const UID_KEY = 'low-net.uid';
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * Stable per-tab identity. sessionStorage survives reloads within the tab,
 * and is isolated between tabs, so every tab gets its own ID.
 * @returns {string}
 */
export function getUid() {
  let uid = sessionStorage.getItem(UID_KEY);
  if (!uid || !/^[A-Z0-9]{4}$/.test(uid)) {
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    uid = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
    sessionStorage.setItem(UID_KEY, uid);
  }
  return uid;
}

/**
 * Random per-load salt so stroke IDs never collide after a refresh
 * (session keeps the same UID but counters restart).
 * @returns {string}
 */
export function getSessionSalt() {
  const bytes = new Uint8Array(2);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('');
}
