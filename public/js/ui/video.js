'use strict';

/**
 * Video UI — renders remote frames and local preview.
 * Uses canvas for remote (object-fit: contain via CSS), video element for local preview.
 */

export class VideoUI {
  /**
   * @param {{
   *   remoteCanvas: HTMLCanvasElement,
   *   localCanvas: HTMLCanvasElement,
   *   localWrap: HTMLElement,
   *   placeholder: HTMLElement
   * }} elements
   */
  constructor(elements) {
    this.remoteCanvas = elements.remoteCanvas;
    this.localCanvas = elements.localCanvas;
    this.localWrap = elements.localWrap;
    this.placeholder = elements.placeholder;

    this.remoteCtx = this.remoteCanvas.getContext('2d');
    this.localCtx = this.localCanvas.getContext('2d');

    this.remoteWidth = 0;
    this.remoteHeight = 0;
    this.hasRemoteFrame = false;
  }

  /**
   * Render a remote frame (Uint8Array grayscale) to canvas.
   * @param {Uint8Array} frame - W×H grayscale
   * @param {number} w
   * @param {number} h
   */
  renderRemote(frame, w, h) {
    if (!frame || frame.length !== w * h) return;

    // Resize canvas if needed
    if (this.remoteCanvas.width !== w || this.remoteCanvas.height !== h) {
      this.remoteCanvas.width = w;
      this.remoteCanvas.height = h;
    }

    // Create ImageData and put
    const imgData = this.remoteCtx.createImageData(w, h);
    const data = imgData.data;
    for (let i = 0, j = 0; i < frame.length; i++, j += 4) {
      const v = frame[i];
      data[j] = v;
      data[j + 1] = v;
      data[j + 2] = v;
      data[j + 3] = 255;
    }
    this.remoteCtx.putImageData(imgData, 0, 0);

    this.remoteWidth = w;
    this.remoteHeight = h;
    this.hasRemoteFrame = true;
    this.placeholder.hidden = true;
  }

  /**
   * Render local preview frame.
   * @param {Uint8Array} frame - W×H grayscale
   * @param {number} w
   * @param {number} h
   */
  renderLocal(frame, w, h) {
    if (!frame || frame.length !== w * h) return;

    if (this.localCanvas.width !== w || this.localCanvas.height !== h) {
      this.localCanvas.width = w;
      this.localCanvas.height = h;
    }

    const imgData = this.localCtx.createImageData(w, h);
    const data = imgData.data;
    for (let i = 0, j = 0; i < frame.length; i++, j += 4) {
      const v = frame[i];
      data[j] = v;
      data[j + 1] = v;
      data[j + 2] = v;
      data[j + 3] = 255;
    }
    this.localCtx.putImageData(imgData, 0, 0);

    this.localWrap.hidden = false;
  }

  /** Show waiting state (no remote yet). */
  showWaiting() {
    this.hasRemoteFrame = false;
    this.placeholder.hidden = false;
    this.remoteCtx.clearRect(0, 0, this.remoteCanvas.width, this.remoteCanvas.height);
  }

  /** Hide local preview (camera off). */
  hideLocal() {
    this.localWrap.hidden = true;
  }

  /** Get remote canvas for potential downstream use. */
  getRemoteCanvas() {
    return this.remoteCanvas;
  }
}