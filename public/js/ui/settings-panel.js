'use strict';

/**
 * SettingsPanel — manages the settings drawer with video mode toggle,
 * camera presets, and live metrics display.
 */

export class SettingsPanel {
  /**
   * @param {{
   *   panel: HTMLElement,
   *   videoManager: import('../video/manager.js').VideoManager | null,
   *   avatarManager: import('../avatar/avatar.js').AvatarManager | null,
   *   conn: import('../net/connection.js').Connection,
   *   onVideoModeChange: (mode: 'camera'|'avatar') => void,
   *   onConfigChange: (config: object) => void
   * }} opts
   */
  constructor(opts) {
    this.panel = opts.panel;
    this.videoManager = opts.videoManager;
    this.avatarManager = opts.avatarManager;
    this.conn = opts.conn;
    this.onVideoModeChange = opts.onVideoModeChange;
    this.onConfigChange = opts.onConfigChange;

    this.visible = false;
    this._bindElements();
    this._bindEvents();
    this._updateMetricsInterval = null;
  }

  _bindElements() {
    // Video mode radios
    this.modeRadios = this.panel.querySelectorAll('input[name="video-mode"]');

    // Camera settings
    this.resolutionSelect = this.panel.querySelector('#setting-resolution');
    this.fpsSelect = this.panel.querySelector('#setting-fps');
    this.blockSelect = this.panel.querySelector('#setting-block');
    this.thresholdRange = this.panel.querySelector('#setting-threshold');
    this.thresholdValue = this.panel.querySelector('#threshold-value');
    this.quantSelect = this.panel.querySelector('#setting-quant');
    this.encodingSelect = this.panel.querySelector('#setting-encoding');
    this.keyframeSelect = this.panel.querySelector('#setting-keyframe');
    this.adaptiveCheckbox = this.panel.querySelector('#setting-adaptive');

    // Live metrics
    this.metricsGrid = this.panel.querySelector('#live-metrics');
  }

  _bindEvents() {
    // Video mode change
    for (const radio of this.modeRadios) {
      radio.addEventListener('change', () => {
        if (radio.checked) {
          this.onVideoModeChange(radio.value);
          this._updateCameraSettingsVisibility(radio.value === 'camera');
        }
      });
    }

    // Camera config changes
    const configSelects = [
      this.resolutionSelect,
      this.fpsSelect,
      this.blockSelect,
      this.quantSelect,
      this.encodingSelect,
      this.keyframeSelect,
    ];
    for (const sel of configSelects) {
      sel?.addEventListener('change', () => this._emitConfigChange());
    }

    this.thresholdRange?.addEventListener('input', () => {
      this.thresholdValue.textContent = this.thresholdRange.value;
    });
    this.thresholdRange?.addEventListener('change', () => this._emitConfigChange());

    this.adaptiveCheckbox?.addEventListener('change', () => this._emitConfigChange());

    // Close button
    this.panel.querySelector('#settings-close')?.addEventListener('click', () => this.hide());
  }

  _emitConfigChange() {
    const config = {
      width: parseInt(this.resolutionSelect?.value.split('x')[0]) || 120,
      height: parseInt(this.resolutionSelect?.value.split('x')[1]) || 90,
      targetFps: parseInt(this.fpsSelect?.value) || 10,
      blockSize: parseInt(this.blockSelect?.value) || 4,
      threshold: parseInt(this.thresholdRange?.value) || 12,
      quantization: parseInt(this.quantSelect?.value) === 4 ? 1 : 0, // QUANT.BIT4 : QUANT.BIT8
      encoding: this.encodingSelect?.value === 'rle' ? 1 : (this.encodingSelect?.value === 'bitpack4' ? 2 : 0),
      keyframeIntervalSec: parseInt(this.keyframeSelect?.value) || 2,
      adaptiveFps: this.adaptiveCheckbox?.checked ?? true,
    };
    this.onConfigChange(config);
  }

  _updateCameraSettingsVisibility(show) {
    const cameraSection = this.panel.querySelector('section:nth-of-type(2)');
    if (cameraSection) {
      cameraSection.style.display = show ? 'block' : 'none';
    }
  }

  /** Show the panel. */
  show() {
    this.visible = true;
    this.panel.hidden = false;
    this.panel.classList.add('open');
    this._startMetricsUpdates();
  }

  /** Hide the panel. */
  hide() {
    this.visible = false;
    this.panel.classList.remove('open');
    setTimeout(() => { this.panel.hidden = true; }, 250);
    this._stopMetricsUpdates();
  }

  /** Toggle visibility. */
  toggle() {
    if (this.visible) this.hide(); else this.show();
  }

  /** Update video manager reference (when camera starts). */
  setVideoManager(mgr) {
    this.videoManager = mgr;
  }

  /** Update avatar manager reference. */
  setAvatarManager(mgr) {
    this.avatarManager = mgr;
  }

  /** Set video mode (called externally). */
  setMode(mode) {
    const radio = this.panel.querySelector(`input[name="video-mode"][value="${mode}"]`);
    if (radio) {
      radio.checked = true;
      this._updateCameraSettingsVisibility(mode === 'camera');
    }
  }

  /** Populate settings from video manager config. */
  syncFromVideoManager() {
    if (!this.videoManager) return;
    const cfg = this.videoManager.getConfig();
    this.resolutionSelect.value = `${cfg.width}x${cfg.height}`;
    this.fpsSelect.value = String(cfg.targetFps);
    this.blockSelect.value = String(cfg.blockSize);
    this.thresholdRange.value = String(cfg.threshold);
    this.thresholdValue.textContent = String(cfg.threshold);
    this.quantSelect.value = cfg.quantization === 1 ? '4' : '8';
    this.encodingSelect.value = cfg.encoding === 1 ? 'rle' : (cfg.encoding === 2 ? 'bitpack4' : 'raw');
    this.keyframeSelect.value = String(cfg.keyframeIntervalSec);
    this.adaptiveCheckbox.checked = cfg.adaptiveFps;
  }

  /** Start periodic metrics updates. */
  _startMetricsUpdates() {
    if (this._updateMetricsInterval) return;
    this._updateMetricsInterval = setInterval(() => this._renderMetrics(), 500);
    this._renderMetrics();
  }

  _stopMetricsUpdates() {
    clearInterval(this._updateMetricsInterval);
    this._updateMetricsInterval = null;
  }

  _renderMetrics() {
    if (!this.metricsGrid) return;

    let videoMetrics = null;
    let avatarMetrics = null;

    if (this.videoManager) {
      videoMetrics = this.videoManager.getMetrics();
    }
    // Avatar metrics would come from avatarManager if exposed

    const netMetrics = this.conn.metrics.snapshot();
    const videoRate = netMetrics.rate.video || {};

    const rows = [
      { label: 'Video ↑', value: videoRate.upBps ? `${(videoRate.upBps / 1024).toFixed(1)} kB/s` : '—', warn: false },
      { label: 'Video ↓', value: videoRate.downBps ? `${(videoRate.downBps / 1024).toFixed(1)} kB/s` : '—', warn: false },
      { label: 'Avg ↑', value: videoRate.upBpsAvg ? `${(videoRate.upBpsAvg / 1024).toFixed(1)} kB/s` : '—', warn: false },
      { label: 'Peak ↑', value: videoRate.peakUpBps ? `${(videoRate.peakUpBps / 1024).toFixed(1)} kB/s` : '—', warn: false },
    ];

    if (videoMetrics) {
      rows.push(
        { label: 'Resolution', value: videoMetrics.resolution || '—', warn: false },
        { label: 'FPS target', value: String(videoMetrics.targetFps || '—'), warn: false },
        { label: 'FPS actual', value: videoMetrics.actualFps ? videoMetrics.actualFps.toFixed(1) : '—', warn: false },
        { label: 'Frames sent', value: String(videoMetrics.framesSent || 0), warn: false },
        { label: 'Frames skipped', value: String(videoMetrics.framesSkipped || 0), warn: false },
        { label: 'Keyframes', value: String(videoMetrics.keyframesSent || 0), warn: false },
        { label: 'Deltas', value: String(videoMetrics.deltaFramesSent || 0), warn: false },
        { label: 'Blocks/frame', value: String(videoMetrics.totalBlocks || 0), warn: false },
        { label: 'Changed', value: `${videoMetrics.changedBlocks || 0} (${(videoMetrics.motionScore * 100).toFixed(1)}%)`, warn: videoMetrics.motionScore > 0.5 },
        { label: 'Motion score', value: videoMetrics.motionScore ? videoMetrics.motionScore.toFixed(3) : '—', warn: false },
        { label: 'Avg block Δ', value: videoMetrics.avgBlockDelta ? videoMetrics.avgBlockDelta.toFixed(1) : '—', warn: false },
        { label: 'Avg pixel Δ', value: videoMetrics.avgPixelDelta ? videoMetrics.avgPixelDelta.toFixed(1) : '—', warn: false },
        { label: 'CPU/frame', value: videoMetrics.cpuTime ? `${videoMetrics.cpuTime.toFixed(1)} ms` : '—', warn: videoMetrics.cpuTime > 20 },
      );
    }

    // Network totals
    rows.push(
      { label: 'WS ↑ total', value: `${(netMetrics.sent.bytes / 1024).toFixed(1)} kB`, warn: false },
      { label: 'WS ↓ total', value: `${(netMetrics.recv.bytes / 1024).toFixed(1)} kB`, warn: false },
      { label: 'RTT', value: netMetrics.rtt.samples ? `${netMetrics.rtt.last} ms` : '—', warn: netMetrics.rtt.last > 300 },
      { label: 'Reconnects', value: String(netMetrics.reconnects), warn: netMetrics.reconnects > 0 },
    );

    this.metricsGrid.innerHTML = rows.map(r => `
      <dt>${r.label}</dt>
      <dd class="${r.warn ? 'warn' : 'ok'}">${r.value}</dd>
    `).join('');
  }
}