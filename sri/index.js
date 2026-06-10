'use strict';

/**
 * SRI Ecuador — Orquestador de facturación electrónica.
 *
 * Expone:
 *   emitirFactura(order, secuencial) → { ok, claveAcceso, ... }
 *   getSRIConfig()                   → objeto con variables de entorno SRI
 */

const fs   = require('fs');
const path = require('path');

const { generarClaveAcceso }              = require('./claveAcceso');
const { buildFacturaXML, detectarTipoId } = require('./xmlFactura');
const { signXML }                         = require('./signer');
const { enviarComprobante, autorizarComprobante } = require('./client');

/* ── Paths ──────────────────────────────────────────────────────── */
const DATA_DIR   = path.join(__dirname, '..', 'data');
const P12_LOCAL  = path.join(DATA_DIR, '.p12');

/**
 * Lee el certificado .p12 desde:
 *   1. Variable de entorno P12_BASE64 (base64)
 *   2. Variable de entorno P12_PATH   (ruta al archivo)
 *   3. data/.p12                       (archivo local)
 * @returns {Buffer}
 */
function getP12() {
    if (process.env.P12_BASE64) {
        return Buffer.from(process.env.P12_BASE64, 'base64');
    }
    const p12Path = process.env.P12_PATH || P12_LOCAL;
    if (fs.existsSync(p12Path)) {
        return fs.readFileSync(p12Path);
    }
    throw new Error('Certificado .p12 no encontrado. Configure P12_BASE64, P12_PATH o suba el archivo data/.p12');
}

/**
 * Lee la configuración SRI desde variables de entorno.
 * @returns {object}
 */
function getSRIConfig() {
    return {
        ambiente:        process.env.SRI_AMBIENTE       || '1',
        ruc:             process.env.SRI_RUC             || '',
        razonSocial:     process.env.SRI_RAZON_SOCIAL    || 'EXPRESART',
        nombreComercial: process.env.SRI_NOMBRE_COMERCIAL || 'EXPRESART',
        direccion:       process.env.SRI_DIRECCION        || '',
        estab:           process.env.SRI_ESTAB            || '001',
        ptoEmi:          process.env.SRI_PTO_EMI          || '001',
        p12Password:     process.env.P12_PASSWORD          || '',
    };
}

/**
 * Espera los milisegundos indicados.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Emite una factura electrónica para el pedido dado.
 *
 * Flujo:
 *   1. Genera claveAcceso
 *   2. Detecta tipoIdComprador
 *   3. Construye XML
 *   4. Firma XML
 *   5. Envía al SRI (recepción)
 *   6. Si no RECIBIDA: retorna error
 *   7. Sondea autorización hasta 5 veces (2 s de espera entre intentos)
 *   8. Retorna resultado
 *
 * @param {object} order       Objeto de orden confirmada
 * @param {string|number} secuencial  Número secuencial de la factura
 * @returns {Promise<object>}
 */
async function emitirFactura(order, secuencial) {
    const cfg = getSRIConfig();

    // Validar configuración mínima
    if (!cfg.ruc) throw new Error('SRI_RUC no configurado');

    // 1) Fecha de emisión
    const fecha = order.confirmedAt
        ? order.confirmedAt.slice(0, 10)
        : new Date().toISOString().slice(0, 10);

    // Extraer solo la parte numérica del secuencial si viene como "001-001-000000001"
    let secNum = secuencial;
    if (typeof secuencial === 'string' && secuencial.includes('-')) {
        secNum = parseInt(secuencial.split('-').pop(), 10);
    }

    // 2) Generar clave de acceso
    const claveAcceso = generarClaveAcceso({
        fecha,
        ruc:        cfg.ruc,
        ambiente:   cfg.ambiente,
        estab:      cfg.estab,
        ptoEmi:     cfg.ptoEmi,
        secuencial: secNum,
        tipoEmision: '1'
    });

    // 3) Detectar tipo de identificación del comprador
    const tipoIdComprador = detectarTipoId(order.customerDoc);

    // 4) Construir XML
    const xmlUnsigned = buildFacturaXML({
        claveAcceso,
        ambiente:                cfg.ambiente,
        razonSocial:             cfg.razonSocial,
        nombreComercial:         cfg.nombreComercial,
        ruc:                     cfg.ruc,
        estab:                   cfg.estab,
        ptoEmi:                  cfg.ptoEmi,
        secuencial:              secNum,
        dirMatriz:               cfg.direccion,
        fecha,
        tipoIdComprador,
        razonSocialComprador:    order.customerName,
        identificacionComprador: order.customerDoc,
        subtotal:                order.subtotal,
        iva:                     order.iva,
        total:                   order.amount,
        concepto:                order.concept,
        email:                   order.customerEmail,
        ivaRate:                 order.ivaRate || 15
    });

    // 5) Firmar XML
    const p12Buffer = getP12();
    const xmlSigned = signXML(xmlUnsigned, p12Buffer, cfg.p12Password);

    // 6) Enviar al SRI
    const recepcion = await enviarComprobante(xmlSigned, cfg.ambiente);
    console.log('SRI recepcion:', JSON.stringify(recepcion));

    if (recepcion.estado !== 'RECIBIDA') {
        const errMsg = recepcion.mensajes && recepcion.mensajes.length > 0
            ? recepcion.mensajes.map(m => m.mensaje || m.informacionAdicional || '').filter(Boolean).join('; ')
            : `Estado SRI: ${recepcion.estado}`;
        return { ok: false, claveAcceso, error: errMsg };
    }

    // 7) Sondear autorización (máximo 5 intentos, 2 s entre cada uno)
    const MAX_INTENTOS = 5;
    const DELAY_MS     = 2000;

    for (let intento = 1; intento <= MAX_INTENTOS; intento++) {
        await delay(DELAY_MS);

        let autResp;
        try {
            autResp = await autorizarComprobante(claveAcceso, cfg.ambiente);
        } catch (e) {
            // Error de red en el intento; seguir intentando si quedan
            if (intento === MAX_INTENTOS) {
                return { ok: false, claveAcceso, xmlSigned, error: 'Error consultando autorización: ' + e.message };
            }
            continue;
        }

        const auts = autResp.autorizaciones || [];
        if (!auts.length) continue;

        const aut = auts[0];

        if (aut.estado === 'AUTORIZADO') {
            return {
                ok:                 true,
                claveAcceso,
                numeroAutorizacion: aut.numeroAutorizacion,
                fechaAutorizacion:  aut.fechaAutorizacion,
                xmlSigned,
                xmlAutorizado:      aut.comprobante || xmlSigned
            };
        }

        if (aut.estado === 'NO AUTORIZADO') {
            const errMsg = aut.mensajes && aut.mensajes.length > 0
                ? aut.mensajes.map(m => m.mensaje || '').filter(Boolean).join('; ')
                : 'Comprobante NO AUTORIZADO por el SRI';
            return { ok: false, claveAcceso, xmlSigned, error: errMsg };
        }

        // Otro estado (IN PROCESS, etc.) — seguir esperando
    }

    // Timeout: se envió pero no se autorizó en tiempo
    return {
        ok:         false,
        claveAcceso,
        xmlSigned,
        error:      'RECIBIDA sin autorización (timeout después de ' + MAX_INTENTOS + ' intentos)'
    };
}

module.exports = { emitirFactura, getSRIConfig };
