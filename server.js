const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '3000', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.zip': 'application/zip'
};

/**
 * Descobre os endereços IPv4 da rede local (Wi-Fi / Ethernet),
 * priorizando faixas domésticas (192.168.x.x, 10.x.x.x) sobre adaptadores virtuais.
 */
function getLocalNetworkIPs() {
  const interfaces = os.networkInterfaces();
  const candidates = [];

  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        const lowerName = name.toLowerCase();
        const isVirtual =
          lowerName.includes('vethernet') ||
          lowerName.includes('wsl') ||
          lowerName.includes('docker') ||
          lowerName.includes('vbox') ||
          lowerName.includes('vmware') ||
          lowerName.includes('loopback');

        let priority = 10;
        if (addr.address.startsWith('192.168.')) priority = 100;
        else if (addr.address.startsWith('10.')) priority = 80;
        else if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(addr.address)) priority = 70;

        if (isVirtual) priority -= 50;
        if (lowerName.includes('wi-fi') || lowerName.includes('wlan') || lowerName.includes('wireless')) {
          priority += 25;
        }

        candidates.push({
          name,
          address: addr.address,
          priority,
          isVirtual
        });
      }
    }
  }

  candidates.sort((a, b) => b.priority - a.priority);
  return candidates;
}

// ============================================================================
// Implementação RFC-6455 WebSocket Nativa (Zero Dependências Externas)
// Suporta frames de texto (JSON signaling) e binários (Int16 PCM de baixa latência)
// ============================================================================

const WS_MAGIC_STRING = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function createWsFrame(payloadBuffer, opcode = 0x01) {
  const length = payloadBuffer.length;
  let header;

  if (length < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = 0x80 | opcode;
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  return Buffer.concat([header, payloadBuffer]);
}

function sendWsJson(client, data) {
  if (!client || !client.socket || client.socket.destroyed) return;
  try {
    const payload = Buffer.from(JSON.stringify(data), 'utf8');
    client.socket.write(createWsFrame(payload, 0x01));
  } catch (_) {
    // Ignora erro de socket fechado
  }
}

function sendWsBinary(client, buffer) {
  if (!client || !client.socket || client.socket.destroyed) return;
  try {
    client.socket.write(createWsFrame(buffer, 0x02));
  } catch (_) {
    // Ignora erro de socket fechado
  }
}

// Estado global de clientes conectados na rede local
const clients = new Map(); // clientId -> clientObj
let nextNumericSlot = 1;

function getPublicDeviceList() {
  const list = [];
  for (const c of clients.values()) {
    list.push({
      id: c.id,
      numericId: c.numericId,
      name: c.name,
      deviceType: c.deviceType,
      role: c.role,
      isStreaming: c.isStreaming,
      sourceLabel: c.sourceLabel,
      transportMode: c.transportMode,
      sampleRate: c.sampleRate,
      channels: c.channels,
      remoteVolume: c.remoteVolume,
      remoteMuted: c.remoteMuted,
      connectedAt: c.connectedAt
    });
  }
  return list;
}

function broadcastDeviceList() {
  const devices = getPublicDeviceList();
  for (const c of clients.values()) {
    sendWsJson(c, {
      type: 'devices-update',
      devices
    });
  }
}

function handleWsMessage(client, opcode, payload) {
  // Opcode 0x02 = Binary Audio Frame (Int16 PCM stream)
  // Header de 8 bytes:
  // [0..1] uint16BE: numericId do transmissor (preenchido/validado pelo servidor)
  // [2..3] uint16BE: sequence number
  // [4..5] uint16BE: sampleRate / 100 (ex: 480 = 48000Hz, 441 = 44100Hz)
  // [6]    uint8:    channels (1 ou 2)
  // [7]    uint8:    flags
  // [8..]  Int16LE:  amostras de áudio PCM
  if (opcode === 0x02) {
    if (payload.length < 8) return;
    // Garante que o numericId no cabeçalho corresponde ao transmissor real
    payload.writeUInt16BE(client.numericId, 0);

    const frame = createWsFrame(payload, 0x02);
    for (const target of clients.values()) {
      if (target.id !== client.id && (target.role === 'receiver' || target.role === 'both')) {
        if (target.socket && !target.socket.destroyed) {
          try {
            target.socket.write(frame);
          } catch (_) {}
        }
      }
    }
    return;
  }

  // Opcode 0x01 = Text JSON Message
  if (opcode === 0x01) {
    let msg;
    try {
      msg = JSON.parse(payload.toString('utf8'));
    } catch (_) {
      return;
    }

    switch (msg.type) {
      case 'register': {
        if (msg.name) client.name = String(msg.name).slice(0, 50);
        if (msg.deviceType) client.deviceType = String(msg.deviceType).slice(0, 24);
        if (msg.role) client.role = msg.role;
        if (typeof msg.isStreaming === 'boolean') client.isStreaming = msg.isStreaming;
        if (msg.sourceLabel) client.sourceLabel = String(msg.sourceLabel).slice(0, 60);
        if (msg.transportMode) client.transportMode = msg.transportMode;
        if (msg.sampleRate) client.sampleRate = Number(msg.sampleRate) || 48000;
        if (msg.channels) client.channels = Number(msg.channels) || 2;
        broadcastDeviceList();
        break;
      }

      case 'stream-state': {
        client.isStreaming = Boolean(msg.isStreaming);
        if (msg.sourceLabel !== undefined) client.sourceLabel = String(msg.sourceLabel).slice(0, 60);
        if (msg.transportMode) client.transportMode = msg.transportMode;
        if (msg.sampleRate) client.sampleRate = Number(msg.sampleRate) || 48000;
        if (msg.channels) client.channels = Number(msg.channels) || 2;
        broadcastDeviceList();
        break;
      }

      case 'remote-mixer-control': {
        // Permite controlar o volume/mute de um canal remotamente (ex: ajustar pelo PC o volume que sai no iPhone)
        const targetSender = clients.get(msg.targetId);
        if (targetSender) {
          if (typeof msg.volume === 'number') {
            targetSender.remoteVolume = Math.max(0, Math.min(2, msg.volume));
          }
          if (typeof msg.muted === 'boolean') {
            targetSender.remoteMuted = msg.muted;
          }
        }
        // Propaga para todos os receptores
        for (const c of clients.values()) {
          sendWsJson(c, {
            type: 'remote-mixer-Sync',
            targetId: msg.targetId,
            volume: msg.volume,
            muted: msg.muted,
            pan: msg.pan,
            fromId: client.id
          });
        }
        break;
      }

      // Sinalização WebRTC P2P entre emissor e receptor
      case 'webrtc-offer':
      case 'webrtc-answer':
      case 'webrtc-ice':
      case 'webrtc-request-stream': {
        const target = clients.get(msg.targetId);
        if (target) {
          sendWsJson(target, {
            ...msg,
            fromId: client.id,
            fromName: client.name,
            fromNumericId: client.numericId
          });
        }
        break;
      }

      case 'ping-latency': {
        sendWsJson(client, {
          type: 'pong-latency',
          clientTs: msg.clientTs,
          serverTs: Date.now()
        });
        break;
      }

      default:
        break;
    }
  }
}

// ============================================================================
// Servidor HTTP + Upgrade para WebSocket
// ============================================================================

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // Endpoint de diagnóstico e descoberta de IPs da rede local
  if (pathname === '/api/network-info') {
    const ips = getLocalNetworkIPs();
    const primaryIp = ips.length > 0 ? ips[0].address : '127.0.0.1';
    const responseData = {
      hostname: os.hostname(),
      platform: os.platform(),
      port: PORT,
      primaryIp,
      primaryUrl: `http://${primaryIp}:${PORT}`,
      interfaces: ips,
      activeClients: getPublicDeviceList().length
    };

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify(responseData));
    return;
  }

  // Arquivos estáticos em /public
  let safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  if (safePath === '/' || safePath === '\\') {
    safePath = '/index.html';
  }

  const filePath = path.join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Arquivo não encontrado');
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Erro interno do servidor');
      }
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const headers = {
      'Content-Type': contentType,
      'Cache-Control': 'no-store'
    };
    if (ext === '.zip') {
      headers['Content-Disposition'] = `attachment; filename="${path.basename(filePath)}"`;
    }

    res.writeHead(200, headers);
    res.end(content);
  });
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }

  const acceptKey = crypto
    .createHash('sha1')
    .update(key + WS_MAGIC_STRING)
    .digest('base64');

  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`,
    '\r\n'
  ];

  socket.write(headers.join('\r\n'));
  socket.setNoDelay(true); // Desativa algoritmo de Nagle para mínima latência de áudio!

  const clientId = 'dev_' + crypto.randomBytes(5).toString('hex');
  const numericId = nextNumericSlot++ & 0xffff;

  const client = {
    id: clientId,
    numericId,
    socket,
    name: 'Dispositivo ' + numericId,
    deviceType: 'desktop',
    role: 'both',
    isStreaming: false,
    sourceLabel: 'Áudio do Sistema',
    transportMode: 'hybrid',
    sampleRate: 48000,
    channels: 2,
    remoteVolume: 1.0,
    remoteMuted: false,
    connectedAt: Date.now()
  };

  clients.set(clientId, client);

  // Envia boas-vindas com o ID do cliente e a lista atual de dispositivos
  sendWsJson(client, {
    type: 'welcome',
    clientId,
    numericId,
    devices: getPublicDeviceList()
  });

  broadcastDeviceList();

  let buffer = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 2) {
      const firstByte = buffer[0];
      const secondByte = buffer[1];

      const opcode = firstByte & 0x0f;
      const isMasked = (secondByte & 0x80) !== 0;
      let payloadLength = secondByte & 0x7f;
      let offset = 2;

      if (payloadLength === 126) {
        if (buffer.length < 4) return;
        payloadLength = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLength === 127) {
        if (buffer.length < 10) return;
        payloadLength = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskLength = isMasked ? 4 : 0;
      const totalFrameLength = offset + maskLength + payloadLength;

      if (buffer.length < totalFrameLength) {
        return; // Aguarda o restante do frame TCP
      }

      let payload;
      if (isMasked) {
        const maskKey = buffer.subarray(offset, offset + 4);
        const encrypted = buffer.subarray(offset + 4, totalFrameLength);
        payload = Buffer.allocUnsafe(payloadLength);
        for (let i = 0; i < payloadLength; i++) {
          payload[i] = encrypted[i] ^ maskKey[i & 3];
        }
      } else {
        payload = buffer.subarray(offset, totalFrameLength);
      }

      buffer = buffer.subarray(totalFrameLength);

      if (opcode === 0x08) {
        // Close frame
        socket.end();
        return;
      } else if (opcode === 0x09) {
        // Ping -> responde Pong
        socket.write(createWsFrame(payload, 0x0a));
      } else if (opcode === 0x01 || opcode === 0x02) {
        handleWsMessage(client, opcode, payload);
      }
    }
  });

  const cleanup = () => {
    if (clients.has(clientId)) {
      clients.delete(clientId);
      broadcastDeviceList();
    }
  };

  socket.on('close', cleanup);
  socket.on('error', cleanup);
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalNetworkIPs();
  const primaryIp = ips.length > 0 ? ips[0].address : '127.0.0.1';

  console.log('\n====================================================================');
  console.log('  ONDAS LAN // HUB DE AUDIO MULTI-DISPOSITIVOS (PC -> iPhone/Android)');
  console.log('====================================================================');
  console.log(`  [PC Transmissor] Abra no navegador deste PC:`);
  console.log(`  👉 http://localhost:${PORT}`);
  console.log('');
  console.log(`  [iPhone / Android Receptor] Conecte no mesmo Wi-Fi e acesse:`);
  console.log(`  👉 http://${primaryIp}:${PORT}`);
  if (ips.length > 1) {
    console.log('\n  Outros endereços de rede detectados neste computador:');
    ips.slice(1).forEach((ip) => {
      console.log(`     • http://${ip.address}:${PORT} (${ip.name})`);
    });
  }
  console.log('====================================================================\n');
});
