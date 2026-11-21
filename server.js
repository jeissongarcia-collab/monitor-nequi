const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Lista en memoria con los pagos del día
let pagos = [];

/**
 * Limpia el texto recibido eliminando emojis y caracteres extraños
 * que puedan enredar la lectura por voz en español.
 */
function limpiarTextoNotificacion(texto) {
  return String(texto || '')
    .replace(/\u00A0/g, ' ')
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, ' ')
    .replace(/[^\p{L}\p{N}\s$.,:;/\-¿?¡!()]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extrae el monto en pesos colombianos (COP) del texto de la notificación.
 * Soporta $35.000, $1.250.000, $ 45.500,00, COP 80.000 o "35.000 pesos".
 */
function extraerMontoCOP(texto) {
  if (!texto || typeof texto !== 'string') return null;

  // 1. $35.000 o $1.250.000 (con decimales opcionales ,00)
  const matchMilesPunto = texto.match(/(?:\$|COP\b)\s*(\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?/i);
  if (matchMilesPunto) {
    const val = parseInt(matchMilesPunto[1].replace(/\./g, ''), 10);
    if (val > 0) return val;
  }

  // 2. $35,000 o $1,250,000.00
  const matchMilesComa = texto.match(/(?:\$|COP\b)\s*(\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?/i);
  if (matchMilesComa) {
    const val = parseInt(matchMilesComa[1].replace(/,/g, ''), 10);
    if (val > 0) return val;
  }

  // 3. $50000 sin separadores
  const matchSimple = texto.match(/(?:\$|COP\b)\s*(\d+)(?:[.,]\d{1,2})?/i);
  if (matchSimple) {
    const val = parseInt(matchSimple[1], 10);
    if (val > 0) return val;
  }

  // 4. Respaldo: "35.000 pesos"
  const matchPesos = texto.match(/(\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{1,2})?\s*(?:pesos|cop)\b/i);
  if (matchPesos) {
    const val = parseInt(matchPesos[1].replace(/\./g, ''), 10);
    if (val > 0) return val;
  }

  return null;
}

function calcularTotalDia() {
  return pagos.reduce((suma, p) => suma + p.monto, 0);
}

// Endpoint que recibe el JSON desde MacroDroid:
// { "texto": "Nequi: Recibiste una transferencia de Carlos Pérez por $35.000" }
app.post('/pago', (req, res) => {
  const textoBruto = req.body.texto || req.body.text || req.body.mensaje || '';
  const textoCompleto = limpiarTextoNotificacion(textoBruto);

  if (!textoCompleto) {
    return res.status(400).json({ ok: false, error: 'Falta el campo "texto" en el JSON.' });
  }

  const monto = extraerMontoCOP(textoCompleto);
  if (!monto) {
    return res.status(400).json({
      ok: false,
      error: 'No se encontró un monto válido en COP.',
      textoCompleto
    });
  }

  const ahora = new Date();
  const hora = ahora.toLocaleTimeString('es-CO', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  });

  const nuevoPago = {
    id: crypto.randomUUID(),
    monto,
    textoCompleto,
    hora,
    timestamp: ahora.toISOString()
  };

  pagos.unshift(nuevoPago);
  const totalDia = calcularTotalDia();

  // Emitir por Socket.io al navegador con { monto, textoCompleto, hora }
  io.emit('nuevo_pago', {
    id: nuevoPago.id,
    monto: nuevoPago.monto,
    textoCompleto: nuevoPago.textoCompleto,
    hora: nuevoPago.hora,
    totalDia,
    cantidadPagos: pagos.length
  });

  console.log(`[${hora}] $${monto.toLocaleString('es-CO')} — ${textoCompleto}`);
  res.json({
    ok: true,
    monto,
    textoCompleto,
    hora,
    totalDia,
    cantidadPagos: pagos.length
  });
});

app.get('/api/pagos', (req, res) => {
  res.json({
    pagos,
    totalDia: calcularTotalDia(),
    cantidadPagos: pagos.length,
    ultimoPago: pagos[0] || null
  });
});

app.delete('/api/pagos', (req, res) => {
  pagos = [];
  io.emit('caja_reiniciada', { pagos: [], totalDia: 0, cantidadPagos: 0, ultimoPago: null });
  res.json({ ok: true });
});

io.on('connection', (socket) => {
  socket.emit('estado_inicial', {
    pagos,
    totalDia: calcularTotalDia(),
    cantidadPagos: pagos.length,
    ultimoPago: pagos[0] || null
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Monitor POS ejecutándose en http://localhost:${PORT}`);
  console.log(`Endpoint MacroDroid: POST http://TU_IP_LOCAL:${PORT}/pago`);
});