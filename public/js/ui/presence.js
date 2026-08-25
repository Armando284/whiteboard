'use strict';

/**
 * Header presence chips + connection status dot.
 */
export class PresenceBar {
  constructor() {
    this.root = /** @type {HTMLElement} */ (document.getElementById('presence'));
    this.dot = /** @type {HTMLElement} */ (document.getElementById('conn-dot'));
    this.label = /** @type {HTMLElement} */ (document.getElementById('conn-label'));
    this.roomChip = /** @type {HTMLElement} */ (document.getElementById('room-chip-value'));
    this.youChip = /** @type {HTMLElement} */ (document.getElementById('you-chip-value'));
  }

  /**
   * @param {{ cid: string, uid: string }[]} members
   * @param {string} myUid
   */
  setMembers(members, myUid) {
    const sorted = [...members].sort((a, b) => a.uid.localeCompare(b.uid));
    this.root.textContent = '';
    for (const m of sorted) {
      const chip = document.createElement('span');
      chip.className = 'peer' + (m.uid === myUid ? ' self' : '');
      chip.textContent = m.uid;
      if (m.uid === myUid) chip.title = 'you';
      this.root.appendChild(chip);
    }
  }

  /**
   * @param {'up' | 'down' | 'connecting'} status
   */
  setStatus(status) {
    this.dot.className = 'dot ' + status;
    this.label.textContent =
      status === 'up' ? 'CONNECTED' :
      status === 'connecting' ? 'SYNC…' : 'OFFLINE';
  }

  /**
   * @param {string} room
   * @param {string} uid
   */
  setIdentifiers(room, uid) {
    this.roomChip.textContent = room.toUpperCase();
    this.youChip.textContent = uid;
  }
}
