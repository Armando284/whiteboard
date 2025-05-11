const canvas = document.getElementById('pizarra');
const ctx = canvas.getContext('2d');
const $clearCanvas = document.querySelector('#clear-canvas');
let ws;
const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
let lastDrawTime = 0;

/**
 * @type {HTMLSpanElement}
 */
const $activeConnections = document.querySelector('#active-connections>span')

const IS_DEBUG = false
/**
 * @type {HTMLElement}
*/
const $debug = document.querySelector('#debug')
$debug.style.setProperty('--debug-display', IS_DEBUG ? 'flex' : 'none')
/**
 * 
 * @param {boolean} isMobile 
 * @param {number} x 
 * @param {number} y 
 */
const debug = (isMobile, x, y) => {
  if (!IS_DEBUG) return
  $debug.innerText = `isMobile?: ${isMobile}; x: ${x}, y: ${y}`
}

// Función para conectar/reconectar WebSocket
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
  ws = new WebSocket(`${protocol}${window.location.host}`);

  // WebSocket Handlers
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    console.log('Conexión WS establecida');
  };

  ws.onmessage = (e) => {
    if (typeof e.data === 'string') {
      console.log('Connected users', e.data)
      $activeConnections.innerText = e.data
    }
    // Asegúrate de que los datos son un ArrayBuffer
    else if (!(e.data instanceof ArrayBuffer)) {
      console.error("Mensaje recibido no es binario:", e.data);
      return;
    }
    const decompressed = decompressRLE(e.data);
    canvasView.set(decompressed); // Actualizar el buffer local
    redrawCanvas(); // Volver a renderizar
  };

  ws.onerror = (error) => {
    console.error('Error WS:', error);
  };

  ws.onclose = (e) => {
    console.log('Conexión WS cerrada. Intentando reconectar...');
    setTimeout(connectWebSocket, 2000); // Reconexión automática
  };
}

// Iniciar conexión
connectWebSocket();

// Configuración
const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;
const BYTES_PER_PIXEL_ROW = Math.ceil(CANVAS_WIDTH / 8); // 100 bytes por fila
const BUFFER_SIZE = BYTES_PER_PIXEL_ROW * CANVAS_HEIGHT; // 60,000 bytes

// Estado del canvas (1 bit por pixel)
let canvasBuffer = new ArrayBuffer(BUFFER_SIZE);
let canvasView = new Uint8Array(canvasBuffer);

// Inicializar a blanco (todos los bits en 0)
canvasView.fill(0);

function setPixel(x, y, isBlack) {
  const bitIndex = y * CANVAS_WIDTH + x;
  const byteIndex = Math.floor(bitIndex / 8);
  const bitOffset = bitIndex % 8;

  if (isBlack) {
    canvasView[byteIndex] |= (1 << bitOffset); // Set bit a 1
  } else {
    canvasView[byteIndex] &= ~(1 << bitOffset); // Set bit a 0
  }
}

let sendTimeout;

function scheduleSend() {
  clearTimeout(sendTimeout);
  sendTimeout = setTimeout(() => {
    ws.send(canvasView.buffer); // Enviar ArrayBuffer directamente
  }, 300);
}

// Llamar esta función cada vez que se dibuje
// Variables para rastrear el estado del dibujo
let lastX = 0;
let lastY = 0;
let isDrawing = false;

// Función para dibujar una línea entre dos puntos (algoritmo de Bresenham)
function drawLine(x0, y0, x1, y1) {

  let [_x0, _y0, _x1, _y1] = [Math.floor(x0), Math.floor(y0), Math.floor(x1), Math.floor(y1)]
  debug(isMobile, _x1, _y1)
  const dx = Math.abs(_x1 - _x0);
  const dy = Math.abs(_y1 - _y0);
  const sx = (_x0 < _x1) ? 1 : -1;
  const sy = (_y0 < _y1) ? 1 : -1;
  let err = dx - dy;

  while (true) {
    setPixel(_x0, _y0, true); // Dibujar el píxel actual

    if (_x0 === _x1 && _y0 === _y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; _x0 += sx; }
    if (e2 < dx) { err += dx; _y0 += sy; }
  }
}

function getPointerPos(touch) {
  const rect = canvas.getBoundingClientRect();

  const mult = isMobile ?
    {
      x: 800 / rect.width,
      y: 600 / rect.height
    } :
    {
      x: 1,
      y: 1
    };

  return [(touch.clientX - rect.left) * mult.x, (touch.clientY - rect.top) * mult.y];
}

// Prevenir gestos táctiles que interfieren con el dibujo
document.addEventListener('touchmove', (e) => {
  if (isDrawing) {
    e.preventDefault(); // Bloquea el desplazamiento mientras se dibuja
  }
}, { passive: false });

if (isMobile) {
  canvas.style.touchAction = 'none'; // Deshabilita gestos en el canvas

  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    [lastX, lastY] = getPointerPos(e.touches[0])
    console.log(lastX, lastY)
    isDrawing = true;
    setPixel(lastX, lastY, true);
  }, { passive: false });

  canvas.addEventListener('touchmove', (e) => {
    if (!isDrawing) return;
    e.preventDefault();
    const [x, y] = getPointerPos(e.touches[0]);

    if (Date.now() - lastDrawTime < 50) return;
    lastDrawTime = Date.now();

    drawLine(lastX, lastY, x, y);
    [lastX, lastY] = [x, y];
    scheduleSend();
    redrawCanvas(); // Renderizado diferido en móviles

  }, { passive: false });

  canvas.addEventListener('touchend', () => {
    isDrawing = false;
    scheduleSend();
  });
} else {
  // Manejadores de eventos de dibujo
  canvas.onpointerdown = (e) => {

    [lastX, lastY] = getPointerPos(e)
    isDrawing = true;
    setPixel(lastX, lastY, true); // Marcar el punto inicial
  };

  canvas.onpointermove = (e) => {
    if (!isDrawing) return;
    const [x, y] = getPointerPos(e)

    // Optimización para móviles: reducir frecuencia de actualización
    if (isMobile && Date.now() - lastDrawTime < 50) return;
    lastDrawTime = Date.now();

    drawLine(lastX, lastY, x, y);
    [lastX, lastY] = [x, y];

    scheduleSend();
    redrawCanvas(); // Renderizado diferido en móviles
  };

  canvas.onpointerup = canvas.onpointerout = () => {
    isDrawing = false;
    scheduleSend(); // Enviar los últimos cambios
  };
}

function decompressRLE(compressedBuffer) {
  const view = new Uint8Array(compressedBuffer);
  const decompressed = new Uint8Array(BUFFER_SIZE);
  let pos = 0;

  for (let i = 0; i < view.length; i += 2) {
    const value = view[i];
    const count = view[i + 1];
    decompressed.fill(value, pos, pos + count);
    pos += count;
  }

  return decompressed;
}

function redrawCanvas() {
  const imageData = ctx.createImageData(CANVAS_WIDTH, CANVAS_HEIGHT);

  for (let byteIdx = 0; byteIdx < canvasView.length; byteIdx++) {
    const byte = canvasView[byteIdx];
    for (let bitIdx = 0; bitIdx < 8; bitIdx++) {
      const isBlack = (byte & (1 << bitIdx)) !== 0;
      const pixelIdx = byteIdx * 8 + bitIdx;
      const y = Math.floor(pixelIdx / CANVAS_WIDTH);
      const x = pixelIdx % CANVAS_WIDTH;

      const idx = (y * CANVAS_WIDTH + x) * 4;
      imageData.data[idx] = isBlack ? 0 : 255; // R
      imageData.data[idx + 1] = isBlack ? 0 : 255; // G
      imageData.data[idx + 2] = isBlack ? 0 : 255; // B
      imageData.data[idx + 3] = 255; // Alpha
    }
  }

  if (isMobile) {
    requestAnimationFrame(() => {
      ctx.putImageData(imageData, 0, 0);
    });
  } else {
    ctx.putImageData(imageData, 0, 0);
  }
}

$clearCanvas.onclick = (e) => {
  e.stopPropagation()
  e.preventDefault()
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  canvasView.fill(0)
  scheduleSend(); // Programar envío
  redrawCanvas()
}