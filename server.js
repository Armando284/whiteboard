const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, clientTracking: true }); // Habilitar tracking

// Middleware para archivos estáticos
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  next();
});

// Configuración del canvas (800x600 píxeles, 1 bit por píxel)
const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;
const BUFFER_SIZE = Math.ceil((CANVAS_WIDTH * CANVAS_HEIGHT) / 8); // Tamaño en bytes

// Estado global del canvas (inicializado en 0s)
let canvasBuffer = new ArrayBuffer(BUFFER_SIZE);
let canvasView = new Uint8Array(canvasBuffer);

// Función de compresión RLE simple (bytes → [valor, repeticiones])
function compressRLE(buffer) {
  const compressed = [];
  let current = buffer[0];
  let count = 1;

  for (let i = 1; i < buffer.length; i++) {
    if (buffer[i] === current && count < 255) {
      count++;
    } else {
      compressed.push(current, count);
      current = buffer[i];
      count = 1;
    }
  }
  compressed.push(current, count);
  return new Uint8Array(compressed);
}

// Keep-alive endpoint
app.get('/ping', (req, res) => res.send('pong'));

// Configuración detallada de WebSocket
wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`🟢 Nueva conexión WS desde ${ip}`);
  // 1. Enviar canvas comprimido al nuevo cliente
  const compressed = compressRLE(canvasView.buffer);
  const fullCanvasMsg = new Uint8Array(compressed.byteLength + 1);
  fullCanvasMsg[0] = 0xFF; // Tipo: canvas completo
  fullCanvasMsg.set(new Uint8Array(compressed), 1);
  ws.send(fullCanvasMsg.buffer, { binary: true });


  // Manejar errores de conexión
  ws.on('error', (error) => {
    console.error(`🔴 Error en WS (${ip}): ${error.message}`);
  });

  // Cierre de conexión
  ws.on('close', () => {
    console.log(`⚫ Conexión cerrada (${ip})`);
  });

  // Enviar latido periódico
  const heartbeat = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.ping();
    }
  }, 30000);

  // Manejar mensajes
  ws.on('message', (data) => {
    // Convertir Buffer de Node.js a ArrayBuffer
    const arrayBuffer = data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength
    );
    const view = new DataView(arrayBuffer);
    const x = view.getUint16(0);
    const y = view.getUint16(2);
    const type = view.getUint8(4);

    // Calcular posición del bit correspondiente a (x,y)
    const bitIndex = y * CANVAS_WIDTH + x;
    const byteIndex = Math.floor(bitIndex / 8);
    const bitMask = 1 << (bitIndex % 8);

    // Actualizar el canvas (1 = píxel negro)
    canvasView[byteIndex] |= bitMask;
    wss.clients.forEach(client => {
      if (client.readyState === ws.OPEN && client !== ws) {
        client.send(data);
      }
    });
  });
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor en puerto ${PORT}`);
});