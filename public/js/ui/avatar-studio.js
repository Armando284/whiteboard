'use strict';

/**
 * AvatarStudio — sidebar left panel for customising avatar appearance.
 * Shows six trait rows; each click updates the local appearance and sends
 * a 4-byte config frame to peers via AvatarManager.setLocalAppearance().
 *
 * @module ui/avatar-studio
 */

import {
  TRAIT_MAX,
  HAIR_COLORS,
  HAIR_STYLE_NAMES,
  FEATURE_NAMES,
  pack,
  unpack,
  drawFace,
} from '../avatar/looks.js';

const PREVIEW_SIZE = 48;

/**
 * @typedef {import('../avatar/looks.js').Appearance} Appearance
 * @typedef {import('../avatar/avatar.js').AvatarManager} AvatarManager
 */

export class AvatarStudio {
  /**
   * @param {AvatarManager} mgr
   */
  constructor(mgr) {
    this.mgr = mgr;
    this.visible = false;
    this.app = mgr.localAppearance;
    this._buildDOM();
    this._renderPreview();
  }

  /* ── DOM construction ─────────────────────────────────────────────── */

  _buildDOM() {
    const el = document.createElement('aside');
    el.className = 'avatar-studio';
    el.hidden = true;
    el.innerHTML = `
      <header>
        <span>AVATAR</span>
        <button type="button" class="close" title="Close" aria-label="Close avatar studio">&times;</button>
      </header>
      <div class="preview-wrap"><canvas class="preview" width="${PREVIEW_SIZE}" height="${PREVIEW_SIZE}"></canvas></div>
      <div class="options-wrap"></div>`;
    document.body.appendChild(el);
    this.el = el;
    this.previewCanvas = el.querySelector('.preview');
    this.previewCtx = this.previewCanvas.getContext('2d');

    el.querySelector('.close')?.addEventListener('click', () => this.hide());

    const wrap = /** @type {HTMLElement} */ (el.querySelector('.options-wrap'));
    this._addRow(wrap, 'hairStyle', HAIR_STYLE_NAMES);
    this._addColorRow(wrap);
    for (const trait of ['eyes', 'brows', 'nose', 'mouth']) {
      this._addRow(wrap, trait, FEATURE_NAMES[trait]);
    }
  }

  /**
   * Append a generic trait row (label + buttons).
   * @param {HTMLElement} wrap
   * @param {string} trait
   * @param {string[]} labels
   */
  _addRow(wrap, trait, labels) {
    const sec = document.createElement('section');
    sec.innerHTML = `<label>${trait === 'hairStyle' ? 'Hairstyle' : trait.charAt(0).toUpperCase() + trait.slice(1)}</label>`;
    const grid = document.createElement('div');
    grid.className = 'options';
    for (let i = 0; i < labels.length; i++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'opt';
      btn.title = labels[i];
      btn.dataset.trait = trait;
      btn.dataset.val = String(i);
      btn.textContent = labels[i].slice(0, 3);
      if (this.app[trait] === i) btn.classList.add('active');
      btn.addEventListener('click', () => this._onSelect(trait, i));
      grid.appendChild(btn);
    }
    sec.appendChild(grid);
    wrap.appendChild(sec);
  }

  /** Append the hair-color row with 16 coloured swatches. */
  _addColorRow(wrap) {
    const sec = document.createElement('section');
    sec.innerHTML = '<label>Color</label>';
    const grid = document.createElement('div');
    grid.className = 'options';
    for (let i = 0; i < HAIR_COLORS.length; i++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'opt swatch';
      btn.title = `Color ${i}`;
      btn.dataset.trait = 'hairColor';
      btn.dataset.val = String(i);
      btn.style.background = HAIR_COLORS[i];
      if (this.app.hairColor === i) btn.classList.add('active');
      btn.addEventListener('click', () => this._onSelect('hairColor', i));
      grid.appendChild(btn);
    }
    sec.appendChild(grid);
    wrap.appendChild(sec);
  }

  /* ── interaction ──────────────────────────────────────────────────── */

  /** @param {string} trait @param {number} val */
  _onSelect(trait, val) {
    this.app = { ...this.app, [trait]: val };
    // Update active state in the row.
    for (const btn of this.el.querySelectorAll(`[data-trait="${trait}"]`)) {
      btn.classList.toggle('active', Number(btn.dataset.val) === val);
    }
    this._renderPreview();
    this.mgr.setLocalAppearance(this.app);
  }

  /* ── preview canvas ───────────────────────────────────────────────── */

  _renderPreview() {
    const ctx = this.previewCtx;
    const s = PREVIEW_SIZE;
    ctx.clearRect(0, 0, s, s);
    // Skin circle fills the preview
    drawFace(ctx, s / 2, s / 2, s * 0.42, { angle: 0 }, this.app);
  }

  /* ── visibility ───────────────────────────────────────────────────── */

  show() {
    this.visible = true;
    this.el.hidden = false;
    // Sync with whatever is current on mgr (could have been changed externally).
    this.app = this.mgr.localAppearance;
    this._syncAllButtons();
    this._renderPreview();
  }

  hide() {
    this.visible = false;
    this.el.hidden = true;
  }

  toggle() {
    if (this.visible) this.hide(); else this.show();
  }

  /** Sync all button active-states with the current appearance. */
  _syncAllButtons() {
    for (const btn of this.el.querySelectorAll('.opt')) {
      const trait = btn.dataset.trait;
      btn.classList.toggle('active', this.app[trait] === Number(btn.dataset.val));
    }
  }
}
