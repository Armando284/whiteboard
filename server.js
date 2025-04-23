const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
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
let serverCanvasBuffer = new ArrayBuffer(BUFFER_SIZE);
let serverCanvasView = new Uint8Array(serverCanvasBuffer);
serverCanvasView.fill(0); // Inicializar en blanco

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
  return Buffer.from(compressed); // Para Node.js
}

// Keep-alive endpoint
app.get('/ping', (req, res) => res.send('pong'));

// Configuración detallada de WebSocket
wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`🟢 Nueva conexión WS desde ${ip}`);
  // 1. Enviar canvas comprimido al nuevo cliente
  const compressed = compressRLE(serverCanvasView);
  ws.send(compressed);


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
    // Actualizar el buffer del servidor
    const clientView = new Uint8Array(data);
    for (let i = 0; i < clientView.length; i++) {
      serverCanvasView[i] = clientView[i]; // Overwrite (no OR)
    }

    // Re-comprimir y broadcast
    const compressedUpdate = compressRLE(serverCanvasView);
    wss.clients.forEach(client => {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(compressedUpdate);
      }
    });
  });
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor en puerto ${PORT}`);
});