'use strict';

const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, clientTracking: true });

app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  next();
});

// Configuration
const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;
const BUFFER_SIZE = Math.ceil((CANVAS_WIDTH * CANVAS_HEIGHT) / 8); // Size in bytes

// Canvas state (started to 0s)
let serverCanvasBuffer = new ArrayBuffer(BUFFER_SIZE);
let serverCanvasView = new Uint8Array(serverCanvasBuffer);
serverCanvasView.fill(0);

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
  return Buffer.from(compressed);
}

// Keep-alive endpoint
app.get('/ping', (req, res) => res.send('pong'));

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`🟢 New WS connection from: ${ip}`);
  const compressed = compressRLE(serverCanvasView);
  ws.send(wss.clients.size)
  ws.send(compressed);

  ws.on('error', (error) => {
    console.error(`🔴 Error @ WS (${ip}): ${error.message}`);
  });

  ws.on('close', () => {
    console.log(`⚫ Connection closed (${ip})`);
  });

  const heartbeat = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.ping();
    }
  }, 30000);

  ws.on('message', (data) => {
    const clientView = new Uint8Array(data);
    for (let i = 0; i < clientView.length; i++) {
      serverCanvasView[i] = clientView[i]; // Overwrite (no OR)
    }

    const compressedUpdate = compressRLE(serverCanvasView);

    wss.clients.forEach(client => {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(compressedUpdate);
      }
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor en puerto ${PORT}`);
});