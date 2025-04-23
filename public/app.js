const canvas = document.getElementById('pizarra');
const ctx = canvas.getContext('2d');

let ws;

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
    // Asegúrate de que los datos son un ArrayBuffer
    if (!(e.data instanceof ArrayBuffer)) {
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
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = (x0 < x1) ? 1 : -1;
  const sy = (y0 < y1) ? 1 : -1;
  let err = dx - dy;

  while (true) {
    setPixel(x0, y0, true); // Dibujar el píxel actual

    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
  }
}

// Manejadores de eventos de dibujo
canvas.onpointerdown = (e) => {
  const rect = canvas.getBoundingClientRect();
  [lastX, lastY] = [e.clientX - rect.left, e.clientY - rect.top];
  isDrawing = true;
  setPixel(lastX, lastY, true); // Marcar el punto inicial
};

canvas.onpointermove = (e) => {
  if (!isDrawing) return;
  const rect = canvas.getBoundingClientRect();
  const [x, y] = [e.clientX - rect.left, e.clientY - rect.top];

  // Dibujar línea desde el último punto al actual
  drawLine(lastX, lastY, x, y);
  [lastX, lastY] = [x, y]; // Actualizar el último punto

  scheduleSend(); // Programar envío
  redrawCanvas(); // Redibujar
};

canvas.onpointerup = canvas.onpointerout = () => {
  isDrawing = false;
  scheduleSend(); // Enviar los últimos cambios
};

// Prevenir gestos táctiles que interfieren con el dibujo
document.addEventListener('touchmove', (e) => {
  if (isDrawing) {
    e.preventDefault(); // Bloquea el desplazamiento mientras se dibuja
  }
}, { passive: false });

// También previene el "pull-to-refresh" en Safari
document.body.style.overscrollBehaviorY = 'contain';

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

  ctx.putImageData(imageData, 0, 0);
}