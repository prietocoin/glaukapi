/**
 * @file comprobantesService.js
 * Servicio determinista de procesamiento de comprobantes v2 para glaukapi.
 * Integra la taxonomía de 4 roles: ADMIN, ASESOR, SOCIO y PROVEEDOR.
 * Resuelve herencia de tasas y entrega un JSON estandarizado ajustado a Zona Horaria America/Caracas.
 * Persiste automáticamente en la tabla comprobantes_final.
 */

const db = require('./db');

let rawHubUrl = process.env.TASASHUB_URL || 'https://automat-tasashub.fyi6ur.easypanel.host';
if (!rawHubUrl.includes('/api/v1/tasas/calcular')) {
  rawHubUrl = rawHubUrl.replace(/\/+$/, '') + '/api/v1/tasas/calcular';
}
const TASASHUB_BASE_URL = rawHubUrl;

/**
 * Normaliza alias de monedas locales a códigos estándar.
 */
function normalizarCodigoMoneda(moneda) {
  const mon = String(moneda || '').trim().toUpperCase();
  if (mon === 'VES' || mon === 'VEF' || mon === 'VED' || mon === 'BS') return ['VES', 'BS', 'VEF', 'VED'];
  if (mon === 'PEN' || mon === 'SOL' || mon === 'SOLES') return ['PEN', 'SOL', 'SOLES'];
  if (mon === 'ARS' || mon === 'ARG') return ['ARS', 'ARG'];
  if (mon === 'COP') return ['COP'];
  if (mon === 'MXN' || mon === 'MEX') return ['MXN', 'MEX'];
  if (mon === 'USD' || mon === 'USDT' || mon === 'ECU' || mon === 'PYUSD') return ['USD', 'USDT', 'ECU', 'PYUSD'];
  return [mon];
}

/**
 * Sanitiza nombres comerciales para peticiones HTTP a TasasHub.
 */
function limpiarNombreGrupo(nombre) {
  if (!nombre) return '';
  return String(nombre)
    .trim()
    .replace(/^FUNDDA\./i, '')
    .replace(/[^a-zA-Z0-9_\-]/g, '')
    .toUpperCase();
}

/**
 * 🟢 PARSEADOR Y FORMATEADOR DETERMINISTA DE FECHA Y HORA (Zona Horaria Venezuela America/Caracas UTC-4)
 */
function procesarFechaContable(ts) {
  let dateObj = new Date();

  if (ts) {
    if (typeof ts === 'string' && ts.includes('T')) {
      const d = new Date(ts);
      if (!isNaN(d.getTime())) dateObj = d;
    } else {
      const num = Number(ts);
      if (!isNaN(num) && num > 0) {
        const ms = String(num).length === 10 ? num * 1000 : num;
        const d = new Date(ms);
        if (!isNaN(d.getTime())) dateObj = d;
      } else if (typeof ts === 'string' && ts.trim() !== '') {
        const d = new Date(ts);
        if (!isNaN(d.getTime())) dateObj = d;
      }
    }
  }

  const timeZone = 'America/Caracas';

  const fmtFecha = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const fmtHora24 = new Intl.DateTimeFormat('es-VE', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const fmtHumano = new Intl.DateTimeFormat('es-VE', { timeZone, weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: true });

  const fechaFmt = fmtFecha.format(dateObj);
  const horaFmt = fmtHora24.format(dateObj);

  const diaHoraRaw = fmtHumano.format(dateObj);
  const diaHoraHumano = diaHoraRaw.charAt(0).toUpperCase() + diaHoraRaw.slice(1);

  return {
    dateObj,
    iso: dateObj.toISOString(),
    fecha_fmt: fechaFmt,
    hora_fmt: horaFmt,
    dia_hora_humano: diaHoraHumano
  };
}

/**
 * Obtiene el perfil matriz de FUNDDA (Rol ADMIN) desde PostgreSQL.
 */
async function obtenerPerfilMatrizFundda() {
  try {
    const { rows } = await db.query(`
      SELECT id_grupo, nombre, moneda_base, monedas, herencia, rol 
      FROM perfiles_glaukov 
      WHERE UPPER(TRIM(nombre)) = 'FUNDDA' 
         OR UPPER(TRIM(id_grupo)) = '120363401374720092@G.US'
      LIMIT 1;
    `);
    if (!rows[0]) return null;

    const perfil = rows[0];
    perfil.rol = String(perfil.rol || 'ADMIN').toUpperCase().trim();
    if (typeof perfil.monedas === 'string') {
      try { perfil.monedas = JSON.parse(perfil.monedas); } catch (e) { perfil.monedas = {}; }
    }
    return perfil;
  } catch (err) {
    console.error(`[glaukapi ❌ Error DB FUNDDA]:`, err.message);
    return null;
  }
}

/**
 * Obtiene el perfil del grupo en Postgres y resuelve la herencia en base a su Rol.
 */
async function obtenerPerfilGrupo(identificador) {
  if (!identificador || identificador === 'GENERAL' || identificador === 'NO DEFINIDO') {
    return null;
  }

  try {
    const rawVal = String(identificador).trim();
    const numericPart = rawVal.split('@')[0];

    const query = `
      SELECT id_grupo, nombre, moneda_base, monedas, herencia, rol 
      FROM perfiles_glaukov 
      WHERE UPPER(TRIM(id_grupo)) = UPPER(TRIM($1))
         OR UPPER(TRIM(nombre)) = UPPER(TRIM($1))
         OR id_grupo LIKE $2
      LIMIT 1;
    `;
    const { rows } = await db.query(query, [rawVal, `%${numericPart}%`]);

    if (!rows[0]) return null;

    let perfil = rows[0];
    if (typeof perfil.monedas === 'string') {
      try { perfil.monedas = JSON.parse(perfil.monedas); } catch (e) { perfil.monedas = {}; }
    }

    const nombreUpper = String(perfil.nombre || '').toUpperCase().trim();
    if (perfil.rol) {
      perfil.rol = String(perfil.rol).toUpperCase().trim();
    } else if (nombreUpper === 'FUNDDA') {
      perfil.rol = 'ADMIN';
    } else {
      perfil.rol = 'SOCIO';
    }

    if (perfil.rol === 'ASESOR' || perfil.rol === 'ADMIN' || perfil.herencia === true) {
      const matrizFundda = await obtenerPerfilMatrizFundda();
      perfil.grupo_tasashub = 'FUNDDA';

      if (matrizFundda && matrizFundda.monedas) {
        perfil.monedas = { ...matrizFundda.monedas, ...(perfil.monedas || {}) };
      }
      if (!perfil.moneda_base && matrizFundda?.moneda_base) {
        perfil.moneda_base = matrizFundda.moneda_base;
      }
    } else {
      perfil.grupo_tasashub = perfil.nombre;
    }

    return perfil;
  } catch (err) {
    console.error(`[glaukapi ❌ Error DB Perfiles]:`, err.message);
    return null;
  }
}

/**
 * Determina la polaridad exacta (+ / -) leyendo polar_D o polar_P.
 */
function obtenerPolaridadPorTipo(perfil, moneda, tipoCalculado, esSocio1 = true) {
  if (tipoCalculado === 'A') return esSocio1 ? '+' : '-';
  if (!perfil || !perfil.monedas) return '+';

  const codigos = normalizarCodigoMoneda(moneda);
  const keyMoneda = Object.keys(perfil.monedas).find(m => codigos.includes(m.toUpperCase()));
  if (!keyMoneda) return '+';

  const configMoneda = perfil.monedas[keyMoneda];

  if (tipoCalculado === 'D') {
    return configMoneda.polar_D !== undefined ? configMoneda.polar_D : (configMoneda.polaridad || '+');
  }
  if (tipoCalculado === 'P') {
    return configMoneda.polar_P !== undefined ? configMoneda.polar_P : (configMoneda.polaridad || '-');
  }

  return '+';
}

/**
 * Busca en tasas_glaukov el lote publicado con created_at <= timestamp_msg.
 */
async function obtenerLoteTasasPorFecha(dateObj) {
  try {
    const query = `
      SELECT id_tasa, tasas, created_at 
      FROM tasas_glaukov 
      WHERE created_at <= $1 
      ORDER BY created_at DESC 
      LIMIT 1;
    `;
    const { rows } = await db.query(query, [dateObj]);
    let loteObj = rows[0];

    if (!loteObj) {
      const fallbackRes = await db.query('SELECT id_tasa, tasas, created_at FROM tasas_glaukov ORDER BY created_at ASC LIMIT 1;');
      loteObj = fallbackRes.rows[0];
    }

    if (!loteObj) return null;

    if (typeof loteObj.tasas === 'string') {
      try { loteObj.tasas = JSON.parse(loteObj.tasas); } catch (e) { loteObj.tasas = {}; }
    }
    return loteObj;
  } catch (err) {
    console.error(`[glaukapi ❌ Error Lote Query]:`, err.message);
    return null;
  }
}

/**
 * Realiza la consulta HTTP a TasasHub retornando el objeto completo.
 */
async function consultarTasasHub(nombreGrupo, idLote) {
  const grupoLimpio = limpiarNombreGrupo(nombreGrupo);
  if (!grupoLimpio || grupoLimpio === 'GENERAL' || grupoLimpio === 'NODEFINIDO') return null;

  try {
    const grupoQuery = encodeURIComponent(grupoLimpio);
    const loteQuery = idLote ? `?lote=${encodeURIComponent(String(idLote).trim())}` : '';
    const url = `${TASASHUB_BASE_URL}/${grupoQuery}${loteQuery}`;

    const res = await fetch(url);
    if (!res.ok) return null;
    
    const json = await res.json();
    return json?.datos || json?.data || json;
  } catch (err) {
    console.warn(`[glaukapi ⚠️ TasasHub Fetch Error]:`, err.message);
    return null;
  }
}

/**
 * Extrae el valor numérico navegando en datos.tarjetas_paises.
 */
function extraerTasaHub(dataHub, moneda, naturaleza) {
  if (!dataHub) return 'N/A';

  const tarjetas = Array.isArray(dataHub)
    ? dataHub
    : (dataHub.tarjetas_paises || dataHub.datos?.tarjetas_paises || dataHub.data?.tarjetas_paises || []);

  if (!Array.isArray(tarjetas) || tarjetas.length === 0) return 'N/A';

  const codigosAceptados = normalizarCodigoMoneda(moneda);
  const nat = String(naturaleza || '').trim().toUpperCase();

  const tarjeta = tarjetas.find(t => {
    const codeTarjeta = String(t.code || t.moneda || t.pais || '').trim().toUpperCase();
    return codigosAceptados.includes(codeTarjeta);
  });

  if (!tarjeta) return 'N/A';

  const compra = Number(tarjeta.compra);
  const venta = Number(tarjeta.venta);

  if (nat === 'D') {
    if (!isNaN(compra) && compra > 0) return compra;
    if (!isNaN(venta) && venta > 0) return venta;
  }
  if (nat === 'P') {
    if (!isNaN(venta) && venta > 0) return venta;
    if (!isNaN(compra) && compra > 0) return compra;
  }

  return !isNaN(compra) && compra > 0 ? compra : (!isNaN(venta) && venta > 0 ? venta : 'N/A');
}

/**
 * Persiste el resultado procesado en la tabla comprobantes_final.
 */
async function guardarEnComprobantesFinal(resultado) {
  try {
    const numT1 = isNaN(parseFloat(resultado.tasa_1)) ? 1.0 : parseFloat(resultado.tasa_1);
    const numT2 = isNaN(parseFloat(resultado.tasa_2)) ? 1.0 : parseFloat(resultado.tasa_2);

    const query = `
      INSERT INTO comprobantes_final (
        id, hash_largo, hash_corto,
        timestamp_msg, fecha_hora_iso, fecha_fmt, hora_fmt, dia_hora_humano,
        monto, moneda, banco, titular, referencia, tipo, tipo_manual,
        lote, lote_tasa_asignado, es_x2, link_img, url_r2_comprobante,
        nombre_socio_1, socio_1, rol_1, tasa_1, m1_socio, monto_1, me1, moneda_base_socio1, polaridad_1,
        nombre_socio_2, socio_2, rol_2, tasa_2, m2_socio, monto_2, me2, moneda_base_socio2, polaridad_2,
        grupo_1, grupo_2, updated_at
      ) VALUES (
        $1, $2, $3,
        $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $13, $14, $15,
        $16, $17, $18, $19, $20,
        $21, $22, $23, $24, $25, $26, $27, $28, $29,
        $30, $31, $32, $33, $34, $35, $36, $37, $38,
        $39, $40, CURRENT_TIMESTAMP
      )
      ON CONFLICT (hash_largo) 
      DO UPDATE SET
        monto = EXCLUDED.monto,
        moneda = EXCLUDED.moneda,
        banco = EXCLUDED.banco,
        titular = EXCLUDED.titular,
        referencia = EXCLUDED.referencia,
        tipo = EXCLUDED.tipo,
        tipo_manual = EXCLUDED.tipo_manual,
        lote = EXCLUDED.lote,
        lote_tasa_asignado = EXCLUDED.lote_tasa_asignado,
        es_x2 = EXCLUDED.es_x2,
        link_img = COALESCE(EXCLUDED.link_img, comprobantes_final.link_img),
        url_r2_comprobante = COALESCE(EXCLUDED.url_r2_comprobante, comprobantes_final.url_r2_comprobante),
        nombre_socio_1 = EXCLUDED.nombre_socio_1,
        socio_1 = EXCLUDED.socio_1,
        rol_1 = EXCLUDED.rol_1,
        tasa_1 = EXCLUDED.tasa_1,
        m1_socio = EXCLUDED.m1_socio,
        monto_1 = EXCLUDED.monto_1,
        me1 = EXCLUDED.me1,
        moneda_base_socio1 = EXCLUDED.moneda_base_socio1,
        polaridad_1 = EXCLUDED.polaridad_1,
        nombre_socio_2 = EXCLUDED.nombre_socio_2,
        socio_2 = EXCLUDED.socio_2,
        rol_2 = EXCLUDED.rol_2,
        tasa_2 = EXCLUDED.tasa_2,
        m2_socio = EXCLUDED.m2_socio,
        monto_2 = EXCLUDED.monto_2,
        me2 = EXCLUDED.me2,
        moneda_base_socio2 = EXCLUDED.moneda_base_socio2,
        polaridad_2 = EXCLUDED.polaridad_2,
        grupo_1 = EXCLUDED.grupo_1,
        grupo_2 = EXCLUDED.grupo_2,
        updated_at = CURRENT_TIMESTAMP;
    `;

    const values = [
      resultado.id,
      resultado.hash_largo,
      resultado.hash_corto,
      resultado.timestamp_msg,
      resultado.fecha_hora_iso,
      resultado.fecha_fmt,
      resultado.hora_fmt,
      resultado.dia_hora_humano,
      resultado.monto,
      resultado.moneda,
      resultado.banco,
      resultado.titular,
      resultado.referencia,
      resultado.tipo,
      resultado.tipo_manual,
      resultado.lote,
      resultado.lote_tasa_asignado,
      resultado.es_x2,
      resultado.link_img,
      resultado.url_r2_comprobante,
      resultado.nombre_socio_1,
      resultado.socio_1,
      resultado.rol_1,
      numT1,
      resultado.m1_socio,
      resultado.monto_1,
      resultado.me1,
      resultado.moneda_base_socio1,
      resultado.grupo_1?.polaridad || '+',
      resultado.nombre_socio_2,
      resultado.socio_2,
      resultado.rol_2,
      numT2,
      resultado.m2_socio,
      resultado.monto_2,
      resultado.me2,
      resultado.moneda_base_socio2,
      resultado.grupo_2?.polaridad || '-',
      JSON.stringify(resultado.grupo_1 || {}),
      JSON.stringify(resultado.grupo_2 || {})
    ];

    await db.query(query, values);
  } catch (err) {
    console.error(`[glaukapi ❌ Error al guardar en comprobantes_final]:`, err.message);
  }
}

/**
 * 🟢 FUNCIÓN PRINCIPAL EXPORTADA
 */
async function procesarComprobante(item) {
  const hashLargo = String(
    item.hash_largo || 
    item.id || 
    item._id || 
    item.referencia || 
    item.ref || ''
  ).trim();

  const hashCorto = item.hash_corto || (hashLargo ? hashLargo.slice(0, 8).toUpperCase() : 'HASH');

  const monto = Math.abs(Number(item.monto || item.monto_local || 0));
  const moneda = String(item.moneda || item.moneda_local || 'USDT').trim().toUpperCase();

  const rawTs = item.timestamp_msg || item.created_at || item.fecha_hora_comprobante || item.fecha;
  const fechaObj = procesarFechaContable(rawTs);

  const rawGrupo1 = item.id_grupo_1 || item.grupo_raw_1 || item.nombre_socio_1 || item.socio_1 || item.grupo_1 || item.id_chat || 'GENERAL';
  const rawGrupo2 = item.id_grupo_2 || item.grupo_raw_2 || item.nombre_socio_2 || item.socio_2 || item.grupo_2 || 'GENERAL';

  const [perfil1, perfil2, loteGlaukov] = await Promise.all([
    obtenerPerfilGrupo(rawGrupo1),
    obtenerPerfilGrupo(rawGrupo2),
    obtenerLoteTasasPorFecha(fechaObj.dateObj)
  ]);

  const loteCodigo = loteGlaukov?.id_tasa || 'T001';

  const nombreGrupo1 = perfil1?.nombre || rawGrupo1;
  const nombreGrupo2 = perfil2?.nombre || rawGrupo2;

  const rol1 = perfil1?.rol || (String(nombreGrupo1).toUpperCase() === 'FUNDDA' ? 'ADMIN' : 'SOCIO');
  const rol2 = perfil2?.rol || (String(nombreGrupo2).toUpperCase() === 'FUNDDA' ? 'ADMIN' : 'SOCIO');

  const targetTasas1 = perfil1?.grupo_tasashub || 'FUNDDA';
  const targetTasas2 = perfil2?.grupo_tasashub || 'FUNDDA';

  const [dataHub1, dataHub2] = await Promise.all([
    consultarTasasHub(targetTasas1, loteCodigo),
    consultarTasasHub(targetTasas2, loteCodigo)
  ]);

  const monBase1 = String(perfil1?.moneda_base || 'USDT').trim().toUpperCase();
  const monBase2 = String(perfil2?.moneda_base || 'USDT').trim().toUpperCase();

  let tipoCalculado = item.tipo || item.tipo_op1 || item.naturaleza;
  if (!tipoCalculado || tipoCalculado === 'D') {
    if (moneda && monBase1 && moneda === monBase1) tipoCalculado = 'A';
    else if (perfil1?.monedas?.[moneda]?.tipo) tipoCalculado = perfil1.monedas[moneda].tipo;
    else if (moneda !== monBase1 && moneda !== '') tipoCalculado = 'P';
    else tipoCalculado = 'D';
  }

  const esDolarS1 = ['USD', 'USDT', 'PYUSD'].includes(moneda) || monBase1 === moneda;
  const esDolarS2 = ['USD', 'USDT', 'PYUSD'].includes(moneda) || monBase2 === moneda;

  let tasa1 = (tipoCalculado === 'A' || esDolarS1) ? 1 : extraerTasaHub(dataHub1, moneda, tipoCalculado);
  let tasa2 = (tipoCalculado === 'A' || esDolarS2) ? 1 : extraerTasaHub(dataHub2, moneda, tipoCalculado);

  const numT1 = Number(tasa1);
  const numT2 = Number(tasa2);

  const monto1 = !isNaN(numT1) && numT1 > 0 ? Number((monto / numT1).toFixed(2)) : monto;
  const monto2 = !isNaN(numT2) && numT2 > 0 ? Number((monto / numT2).toFixed(2)) : monto;

  const tasaMeBase = Number(loteGlaukov?.tasas?.[moneda] || 1);
  const me1 = tasaMeBase > 0 ? Number((monto / tasaMeBase).toFixed(2)) : monto1;
  const me2 = tasaMeBase > 0 ? Number((monto / tasaMeBase).toFixed(2)) : monto2;

  const polaridad1 = obtenerPolaridadPorTipo(perfil1, moneda, tipoCalculado, true);
  const polaridad2 = obtenerPolaridadPorTipo(perfil2, moneda, tipoCalculado, false);

  const s2Upper = String(nombreGrupo2).toUpperCase().trim();
  const esX2 = Boolean(s2Upper && s2Upper !== 'GENERAL' && s2Upper !== 'NO DEFINIDO');

  const resultado = {
    id: hashLargo,
    hash_largo: hashLargo,
    hash_corto: hashCorto,

    timestamp_msg: rawTs,
    fecha_hora_iso: fechaObj.iso,
    fecha_fmt: fechaObj.fecha_fmt,
    hora_fmt: fechaObj.hora_fmt,
    dia_hora_humano: fechaObj.dia_hora_humano,

    monto,
    moneda,
    banco: item.banco || item.entidad || 'BANCO',
    titular: item.titular || item.nombre_titular || 'TITULAR NO DEFINIDO',
    referencia: item.referencia || item.ref || 'N/A',
    tipo: tipoCalculado,
    tipo_manual: tipoCalculado,
    link_img: item.url_r2_comprobante || item.link_img || item.url_imagen || '',
    url_r2_comprobante: item.url_r2_comprobante || item.link_img || item.url_imagen || '',

    es_x2: esX2,
    lote: loteCodigo,
    lote_tasa_asignado: loteCodigo,

    nombre_socio_1: nombreGrupo1,
    socio_1: nombreGrupo1,
    rol_1: rol1,
    tasa_1: tasa1,
    m1_socio: monto1,
    monto_1: monto1,
    me1,
    moneda_base_socio1: monBase1,

    nombre_socio_2: nombreGrupo2,
    socio_2: nombreGrupo2,
    rol_2: rol2,
    tasa_2: tasa2,
    m2_socio: monto2,
    monto_2: monto2,
    me2,
    moneda_base_socio2: monBase2,

    grupo_1: {
      grupo: nombreGrupo1,
      rol: rol1,
      tasa: tasa1,
      polaridad: polaridad1,
      monto: monto1,
      moneda_base: monBase1,
      me: me1
    },
    grupo_2: {
      grupo: nombreGrupo2,
      rol: rol2,
      tasa: tasa2,
      polaridad: polaridad2,
      monto: monto2,
      moneda_base: monBase2,
      me: me2
    }
  };

  // Guardar/Actualizar automáticamente en comprobantes_final
  await guardarEnComprobantesFinal(resultado);

  return resultado;
}

module.exports = { procesarComprobante };
