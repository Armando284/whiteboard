const canvas = document.getElementById('pizarra');
const ctx = canvas.getContext('2d');

// Configuración del canvas (800x600 píxeles, 1 bit por píxel)
const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;
const BUFFER_SIZE = Math.ceil((CANVAS_WIDTH * CANVAS_HEIGHT) / 8); // Tamaño en bytes

// Función para decodificar RLE y dibujar el canvas
function decompressRLE(buffer) {
  const view = new Uint8Array(buffer);
  const decompressed = new Uint8Array(BUFFER_SIZE);
  let pos = 0;

  for (let i = 0; i < view.length; i += 2) {
    const value = view[i];
    const count = view[i + 1];
    for (let j = 0; j < count; j++) {
      if (pos >= BUFFER_SIZE) break; // Prevenir overflow
      decompressed[pos++] = value;
    }
  }
  return decompressed;
}

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
    const buffer = new Uint8Array(e.data);
    const type = buffer[0];
    const data = buffer.slice(1);

    if (type === 0xFF) {
      const decompressed = decompressRLE(data.buffer);
      renderCanvas(decompressed);
    } else {
      drawFromBinary(e.data);
    }
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

// Configurar herramientas básicas
let isDrawing = false;
let lastX = 0;
let lastY = 0;

// Configurar el estilo inicial
ctx.strokeStyle = '#000000';
ctx.lineWidth = 3;
ctx.lineCap = 'round';

// Renderizar el canvas completo desde datos binarios
function renderCanvas(buffer) {
  const imageData = ctx.createImageData(CANVAS_WIDTH, CANVAS_HEIGHT);
  for (let byteIdx = 0; byteIdx < buffer.length; byteIdx++) {
    const byte = buffer[byteIdx];
    for (let bitIdx = 0; bitIdx < 8; bitIdx++) {
      const isBlack = (byte & (1 << bitIdx)) !== 0;
      const pixelIdx = byteIdx * 8 + bitIdx;
      const x = pixelIdx % CANVAS_WIDTH;
      const y = Math.floor(pixelIdx / CANVAS_WIDTH);

      if (y >= CANVAS_HEIGHT) break;

      const idx = (y * CANVAS_WIDTH + x) * 4;
      imageData.data[idx] = isBlack ? 0 : 255;     // R
      imageData.data[idx + 1] = isBlack ? 0 : 255; // G
      imageData.data[idx + 2] = isBlack ? 0 : 255; // B
      imageData.data[idx + 3] = 255;               // A
    }
  }
  ctx.putImageData(imageData, 0, 0);
}

// Funciones de dibujo
function drawFromBinary(buffer) {
  const data = new DataView(buffer);
  const x = data.getUint16(0);
  const y = data.getUint16(2);
  const type = data.getUint8(4); // 0: inicio, 1: movimiento, 2: fin

  switch (type) {
    case 0:
      lastX = x;
      lastY = y;
      break;
    case 1:
      ctx.beginPath();
      ctx.moveTo(lastX, lastY);
      ctx.lineTo(x, y);
      ctx.stroke();
      lastX = x;
      lastY = y;
      break;
  }
}

// Event Listeners
canvas.addEventListener('pointerdown', startDrawing);
canvas.addEventListener('pointermove', draw);
canvas.addEventListener('pointerup', stopDrawing);
canvas.addEventListener('pointerout', stopDrawing);

function startDrawing(e) {
  isDrawing = true;
  const rect = canvas.getBoundingClientRect();
  [lastX, lastY] = [e.clientX - rect.left, e.clientY - rect.top];
  sendPoint(lastX, lastY, 0);
}

function draw(e) {
  if (!isDrawing) return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  sendPoint(x, y, 1);
  ctx.beginPath();
  ctx.moveTo(lastX, lastY);
  ctx.lineTo(x, y);
  ctx.stroke();
  [lastX, lastY] = [x, y];
}

function stopDrawing() {
  isDrawing = false;
  sendPoint(lastX, lastY, 2);
}

// Enviar datos binarios optimizados (2 bytes para X/Y, 1 byte para tipo)
function sendPoint(x, y, type) {
  const buffer = new ArrayBuffer(5);
  const data = new DataView(buffer);
  data.setUint16(0, x);
  data.setUint16(2, y);
  data.setUint8(4, type);
  ws.send(buffer);
}