'use strict';

const https = require('https');

const URLS = {
    recepcion: {
        '1': 'https://celcer.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline',
        '2': 'https://cel.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline',
    },
    autorizacion: {
        '1': 'https://celcer.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline',
        '2': 'https://cel.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline',
    },
};

function soapPost(url, bodyXml) {
    const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>${bodyXml}</soap:Body>
</soap:Envelope>`;

    return new Promise((resolve, reject) => {
        const u    = new URL(url);
        const data = Buffer.from(envelope, 'utf8');
        const opts = {
            hostname: u.hostname,
            path:     u.pathname + u.search,
            port:     443,
            method:   'POST',
            headers: {
                'Content-Type':   'text/xml;charset=UTF-8',
                'Content-Length': data.length,
            },
        };
        const req = https.request(opts, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end',  () => resolve(Buffer.concat(chunks).toString('utf8')));
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

function tagValue(xml, tag) {
    const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
    return m ? m[1].trim() : '';
}

function cdataOrText(xml, tag) {
    const m = xml.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`));
    return m ? m[1].trim() : '';
}

/**
 * Envía el XML firmado al SRI (recepción).
 * @param {string} xmlSigned  XML firmado (string UTF-8)
 * @param {string|number} ambiente  '1'=pruebas '2'=producción
 * @returns {{ estado: string, mensajes: Array }}
 */
async function enviarComprobante(xmlSigned, ambiente) {
    const xmlBase64 = Buffer.from(xmlSigned, 'utf8').toString('base64');
    const body = `<rec:validarComprobante xmlns:rec="http://ec.gob.sri.ws.recepcion">
  <xml>${xmlBase64}</xml>
</rec:validarComprobante>`;

    const url      = URLS.recepcion[String(ambiente)] || URLS.recepcion['1'];
    const response = await soapPost(url, body);

    const estado   = tagValue(response, 'estado');
    const mensajes = [];
    const re       = /<mensaje>([\s\S]*?)<\/mensaje>/g;
    let m;
    while ((m = re.exec(response)) !== null) {
        const blk = m[1];
        mensajes.push({
            tipo:         tagValue(blk, 'tipo'),
            identificador: tagValue(blk, 'identificador'),
            mensaje:      tagValue(blk, 'mensaje'),
            informacionAdicional: tagValue(blk, 'informacionAdicional'),
        });
    }
    return { estado, mensajes };
}

/**
 * Consulta la autorización del comprobante.
 * @param {string} claveAcceso  Clave de acceso de 49 dígitos
 * @param {string|number} ambiente
 * @returns {{ autorizaciones: Array }}
 */
async function autorizarComprobante(claveAcceso, ambiente) {
    const body = `<aut:autorizacionComprobante xmlns:aut="http://ec.gob.sri.ws.autorizacion">
  <claveAccesoComprobante>${claveAcceso}</claveAccesoComprobante>
</aut:autorizacionComprobante>`;

    const url      = URLS.autorizacion[String(ambiente)] || URLS.autorizacion['1'];
    const response = await soapPost(url, body);

    const autorizaciones = [];
    const re = /<autorizacion>([\s\S]*?)<\/autorizacion>/g;
    let m;
    while ((m = re.exec(response)) !== null) {
        const blk = m[1];
        const mensajes = [];
        const mre = /<mensaje>([\s\S]*?)<\/mensaje>/g;
        let mm;
        while ((mm = mre.exec(blk)) !== null) {
            mensajes.push({
                tipo:    tagValue(mm[1], 'tipo'),
                mensaje: tagValue(mm[1], 'mensaje'),
            });
        }
        autorizaciones.push({
            estado:             tagValue(blk, 'estado'),
            numeroAutorizacion: tagValue(blk, 'numeroAutorizacion'),
            fechaAutorizacion:  tagValue(blk, 'fechaAutorizacion'),
            ambiente:           tagValue(blk, 'ambiente'),
            comprobante:        cdataOrText(blk, 'comprobante'),
            mensajes,
        });
    }
    return { autorizaciones };
}

module.exports = { enviarComprobante, autorizarComprobante };
