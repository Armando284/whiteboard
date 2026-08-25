'use strict';

export const PROTOCOL_VERSION = 1;

/**
 * @param {string} type
 * @param {Record<string, unknown>} [props]
 */
export function envelope(type, props = {}) {
  return { v: PROTOCOL_VERSION, t: type, ...props };
}

/**
 * @param {string} raw
 * @returns {{t: string} & Record<string, unknown> | null}
 */
export function decode(raw) {
  try {
    const msg = JSON.parse(raw);
    return msg && typeof msg.t === 'string' ? msg : null;
  } catch {
    return null;
  }
}
