cat << 'EOF' > index.js
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import pino from 'pino';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

let currentQrImage = null;
let connectionStatus = 'DISCONNECTED';

function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(JSON.stringify(data));
    }
  });
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ status: connectionStatus, qr: currentQrImage }));
});

app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Digital Me — WhatsApp Connection</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    body { background-color: #0b0c10; color: #e0e0e0; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; }
    .card { background: #1f2833; border: 1px solid #45a29e; border-radius: 16px; padding: 32px; max-width: 420px; width: 100%; text-align: center; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
    h2 { color: #66fcf1; margin-bottom: 8px; font-size: 1.5rem; }
    p { color: #c5c6c7; font-size: 0.9rem; margin-bottom: 24px; }
    .qr-container { background: #ffffff; padding: 16px; border-radius: 12px; display: inline-block; margin-bottom: 20px; min-width: 250px; min-height: 250px; position: relative; }
    .qr-container img { width: 250px; height: 250px; display: block; }
    .status-badge { display: inline-block; padding: 6px 16px; border-radius: 20px; font-size: 0.85rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
    .status-CONNECTING { background: rgba(243, 156, 18, 0.2); color: #f39c12; border: 1px solid #f39c12; }
    .status-CONNECTED { background: rgba(46, 204, 113, 0.2); color: #2ecc71; border: 1px solid #2ecc71; }
    .status-DISCONNECTED { background: rgba(231, 76, 60, 0.2); color: #e74c3c; border: 1px solid #e74c3c; }
    .instructions { text-align: left; background: #0b0c10; padding: 16px; border-radius: 8px; margin-top: 20px; font-size: 0.85rem; color: #c5c6c7; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Digital Me Assistant</h2>
    <p>Scan the QR code below to link your WhatsApp account.</p>
    
    <div class="qr-container" id="qr-box">
      <p style="color:#666; line-height:250px;">Generating QR...</p>
    </div>

    <div>
      <span id="status" class="status-badge status-DISCONNECTED">Disconnected</span>
    </div>

    <div class="instructions">
      <strong>Instructions:</strong><br>
      1. Open WhatsApp on your primary phone.<br>
      2. Go to <b>Settings > Linked Devices</b>.<br>
      3. Tap <b>Link a Device</b> and point camera here.
    </div>
  </div>

  <script>
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(protocol + '//' + window.location.host);
    const qrBox = document.getElementById('qr-box');
    const statusBadge = document.getElementById('status');

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      
      if (data.status) {
        statusBadge.textContent = data.status;
        statusBadge.className = 'status-badge status-' + data.status;
      }

      if (data.qr) {
        qrBox.innerHTML = '<img src="' + data.qr + '" alt="WhatsApp QR Code">';
      } else if (data.status === 'CONNECTED') {
        qrBox.innerHTML = '<p style="color:#2ecc71; line-height:250px; font-weight:bold;">Device Connected! ✅</p>';
      }
    };
  </script>
</body>
</html>
  `);
});

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
  
  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      connectionStatus = 'CONNECTING';
      currentQrImage = await QRCode.toDataURL(qr);
      broadcast({ status: connectionStatus, qr: currentQrImage });
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      connectionStatus = 'DISCONNECTED';
      currentQrImage = null;
      broadcast({ status: connectionStatus, qr: null });
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      connectionStatus = 'CONNECTED';
      currentQrImage = null;
      broadcast({ status: connectionStatus, qr: null });
      console.log('WhatsApp Bot successfully connected!');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    // AI message handling logic will be placed here
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server web running on port ${PORT}`);
  startBot();
});
EOF

