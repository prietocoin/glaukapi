/**
 * @file server.js
 * @description Punto de entrada principal para glaukapi.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const db = require('./db');
const { procesarComprobante } = require('./comprobantesService');

const app = express();

app.use(cors());
app.use(express.json());

// Endpoint principal
app.get('/api/v2/comprobantes', async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    let comprobantesRaw = [];

    try {
      const { rows } = await db.query('SELECT * FROM comprobantes LIMIT 50');
      if (rows && rows.length > 0) comprobantesRaw = rows;
    } catch (e) {
      const responseRemit = await fetch(process.env.REMITHUB_URL || 'https://automat-remithub.fyi6ur.easypanel.host/api/comprobantes');
      if (responseRemit.ok) comprobantesRaw = await responseRemit.json();
    }

    const listaData = Array.isArray(comprobantesRaw) ? comprobantesRaw : [comprobantesRaw];
    const resultado = await Promise.all(listaData.map(item => procesarComprobante(item)));

    return res.status(200).json(resultado);
  } catch (err) {
    return res.status(500).json({ error: 'Error interno en glaukapi', detalle: err.message });
  }
});

// Endpoint de salud
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', app: 'glaukapi', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 glaukapi escuchando en el puerto ${PORT}`);
});
