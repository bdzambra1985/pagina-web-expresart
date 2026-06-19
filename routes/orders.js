'use strict';
const crypto  = require('crypto');
const router  = require('express').Router();
const db      = require('../db');
const { requireAuth, requireAdmin, getSession } = require('../middleware/auth');
const { orderLimiter }                         = require('../middleware/rateLimiter');
const { uploader, saveFile, detectMime, ALLOWED_MIMES_RECEIPT } = require('../middleware/upload');
const { emitirFactura, getSRIConfig }  = require('../sri/index');
const { notifyEmail }                  = require('../utils/notify');
const { htmlEncode, generateComprobanteHTML } = require('../utils/html');
const { verifyViewPath }               = require('../utils/crypto');

/* ── Email templates ── */
const BASE_URL = process.env.BASE_URL || 'https://pagina-web-expresart-production.up.railway.app';

const _emailCSS = `
  body{font-family:Arial,sans-serif;background:#f4f4f4;margin:0;padding:20px}
  .card{background:#fff;border-radius:8px;max-width:520px;margin:0 auto;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.1)}
  .header{background:#060002;padding:24px 32px;text-align:center}
  .header h1{color:#c9a227;margin:0;font-size:22px;letter-spacing:1px}
  .header p{color:#fff;margin:6px 0 0;font-size:13px;opacity:.7}
  .banner{background:#c9a227;padding:16px 32px;text-align:center}
  .banner h2{margin:0;color:#060002;font-size:22px}
  .body{padding:24px 32px}
  .row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #eee;font-size:14px}
  .row:last-child{border-bottom:none}
  .label{color:#888;font-weight:bold;min-width:90px;padding-right:6px}
  .value{color:#222;text-align:right}
  .monto{color:#2a8a2a;font-weight:bold;font-size:18px}
  .footer{background:#060002;padding:16px 32px;text-align:center}
  .footer a{display:inline-block;margin-top:8px;background:#c9a227;color:#060002;padding:10px 24px;border-radius:4px;text-decoration:none;font-weight:bold;font-size:14px}
  .ref{color:#aaa;font-size:11px;margin-top:8px}
  .note{color:#555;font-size:13px;padding:12px 32px;border-top:1px solid #eee;text-align:center}`;

function _adminEmailHtml({ name, email, doc, concept, amount, month, id }) {
    const h = htmlEncode;
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${_emailCSS}</style></head><body>
    <div class="card">
      <div class="header"><h1>EXPRESART</h1><p>Nuevo comprobante de pago recibido</p></div>
      <div class="banner"><h2>${h(name)}</h2></div>
      <div class="body">
        <div class="row"><span class="label">Email:</span><span class="value">${h(email)}</span></div>
        <div class="row"><span class="label">Cédula:</span><span class="value">${h(doc)}</span></div>
        <div class="row"><span class="label">Concepto:</span><span class="value">${h(concept)}</span></div>
        <div class="row"><span class="label">Mes:</span><span class="value">${h(month || 'Sin especificar')}</span></div>
        <div class="row"><span class="label">Monto:</span><span class="value monto">$${parseFloat(amount).toFixed(2)}</span></div>
      </div>
      <div class="footer">
        <a href="${BASE_URL}/admin.html">Ver panel de admin</a>
        <div class="ref">Ref: ${h(id)}</div>
      </div>
    </div></body></html>`;
}

function _facturaEmailHtml(order, facturaUrl) {
    const h = htmlEncode;
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${_emailCSS}</style></head><body>
    <div class="card">
      <div class="header"><h1>EXPRESART</h1><p>Tu factura ha sido autorizada por el SRI</p></div>
      <div class="banner"><h2>Hola, ${h(order.customerName)}!</h2></div>
      <div class="body">
        <p style="color:#444;font-size:14px;margin:0 0 16px">Tu pago fue <strong>confirmado</strong> y el SRI ha autorizado la factura electrónica.</p>
        <div class="row"><span class="label">Concepto:</span><span class="value">${h(order.concept)}</span></div>
        <div class="row"><span class="label">Mes:</span><span class="value">${h(order.paymentMonth || 'Sin especificar')}</span></div>
        <div class="row"><span class="label">Monto:</span><span class="value monto">$${parseFloat(order.amount).toFixed(2)}</span></div>
        <div class="row"><span class="label">Factura:</span><span class="value">${h(order.invoiceNumber)}</span></div>
      </div>
      <div class="note">La factura electrónica está adjunta a este correo y también la puedes ver en línea.</div>
      <div class="footer">
        <a href="${facturaUrl}">Ver factura en línea</a>
        <div class="ref">Ref: ${h(order.id)}</div>
      </div>
    </div></body></html>`;
}

/* ── Helpers ── */
function seqFromInvoice(inv) {
    return parseInt((inv || '001-001-000000000').split('-').pop(), 10) || 0;
}
function invoiceFromSeq(n) {
    return '001-001-' + String(n).padStart(9, '0');
}

async function emitirConAutoRetry(orderSnap, startSecuencial, maxAttempts = 100) {
    let seq = seqFromInvoice(startSecuencial);
    let result;
    let consecutiveRejections = 0;
    for (let i = 0; i < maxAttempts; i++) {
        const inv = invoiceFromSeq(seq);
        result = await emitirFactura(orderSnap, inv);
        if (result.ok) return { result, invoiceNumber: inv };
        if (!result.error || !result.error.includes('SECUENCIAL REGISTRADO'))
            return { result, invoiceNumber: inv };
        consecutiveRejections++;
        // After 10 consecutive rejections jump ahead by 10 to find a free gap faster
        const jump = consecutiveRejections >= 10 ? 10 : 1;
        console.log(`Secuencial ${inv} ya registrado en SRI (intento ${i + 1}/${maxAttempts}), probando ${invoiceFromSeq(seq + jump)}…`);
        seq += jump;
    }
    return { result, invoiceNumber: invoiceFromSeq(seq) };
}

/* ── Bank info ── */
router.get('/bank-info', async (_req, res) => {
    try {
        res.json(await db.getBankInfo());
    } catch (e) {
        console.error('[GET /api/bank-info]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

router.post('/bank-info', async (req, res) => {
    try {
        if (!requireAdmin(req, res)) return;
        const { bankName, accountNumber, accountType, accountHolder, ruc, address, email, phone, services } = req.body;
        await db.saveBankInfo({ bankName, accountNumber, accountType, accountHolder, ruc, address, email, phone, services: services || [] });
        res.json({ ok: true });
    } catch (e) {
        console.error('[POST /api/bank-info]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

/* ── Submit payment (student) — must come before /:id routes ── */
router.post('/orders', orderLimiter, (req, res) => {
    uploader.single('receipt')(req, res, async (err) => {
        if (err) return res.status(400).json({ ok: false, message: err.message });
        try {
            const { customerName, customerDoc, customerEmail, concept, amount, notes, paymentMonth } = req.body;
            if (!customerName || !customerDoc || !customerEmail || !concept || !amount)
                return res.status(400).json({ ok: false, message: 'Todos los campos son requeridos' });
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail.trim()))
                return res.status(400).json({ ok: false, message: 'Email inválido' });

            const amountNum = parseFloat(amount);
            if (isNaN(amountNum) || amountNum <= 0)
                return res.status(400).json({ ok: false, message: 'Monto inválido' });

            if (req.file) {
                const mime = detectMime(req.file.buffer);
                if (!mime || !ALLOWED_MIMES_RECEIPT.has(mime))
                    return res.status(400).json({ ok: false, message: 'Solo se permiten imágenes o PDF como comprobante' });
            }

            const receiptUrl = req.file ? await saveFile(req.file.buffer, req.file.originalname, 'receipts') : '';
            const subtotal   = Math.round((amountNum / 1.15) * 100) / 100;
            const iva        = Math.round((amountNum - subtotal) * 100) / 100;

            // Link to student session if present (cookie-based)
            let linkedUserId = null;
            const sess = getSession(req);
            if (sess && sess.role === 'alumno') linkedUserId = sess.userId;

            const order = {
                id: 'ord_' + crypto.randomBytes(8).toString('hex'), token: crypto.randomBytes(16).toString('hex'),
                status: 'pendiente', userId: linkedUserId,
                customerName:  customerName.trim().slice(0, 200),
                customerDoc:   customerDoc.trim().slice(0, 20),
                customerEmail: customerEmail.trim().slice(0, 200),
                concept:       concept.trim().slice(0, 300),
                amount: amountNum, subtotal, iva, ivaRate: 15,
                receiptUrl, notes: (notes || '').trim().slice(0, 500),
                paymentMonth: /^\d{4}-\d{2}$/.test(paymentMonth || '') ? paymentMonth : null,
                invoiceNumber: null, rejectionReason: '',
                createdAt: new Date().toISOString(), confirmedAt: null
            };
            await db.createOrder(order);
            res.json({ ok: true, orderId: order.id, token: order.token });

            // Email al admin
            notifyEmail(
                `Nuevo comprobante de pago — ${order.customerName}`,
                `Alumno: ${order.customerName}\nEmail: ${order.customerEmail}\nCédula: ${order.customerDoc}\nConcepto: ${order.concept}\nMonto: $${parseFloat(order.amount).toFixed(2)}\nMes: ${order.paymentMonth || 'Sin especificar'}\nRef: ${order.id}\n\nRevisa el panel de administración para aprobar o rechazar el pago.`,
                _adminEmailHtml({ name: order.customerName, email: order.customerEmail, doc: order.customerDoc, concept: order.concept, amount: order.amount, month: order.paymentMonth, id: order.id })
            );
        } catch (e) {
            console.error('[POST /api/orders]', e);
            res.status(500).json({ ok: false, message: 'Error interno' });
        }
    });
});

/* ── Cash invoice (admin) ── */
router.post('/orders/cash-invoice', async (req, res) => {
    try {
        if (!requireAdmin(req, res)) return;
        const { customerName, customerDoc, customerEmail, concept, amount, paymentMonth, notes, userId: linkedUserId } = req.body;
        if (!customerName || !customerDoc || !customerEmail || !concept || !amount)
            return res.status(400).json({ ok: false, message: 'Completa todos los campos obligatorios' });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail.trim()))
            return res.status(400).json({ ok: false, message: 'Email inválido' });

        const amountNum = parseFloat(amount);
        if (isNaN(amountNum) || amountNum <= 0)
            return res.status(400).json({ ok: false, message: 'Monto inválido' });

        let resolvedUserId = null;
        if (linkedUserId) {
            const linkedUser = await db.getUserById(linkedUserId);
            if (linkedUser && linkedUser.role === 'alumno') resolvedUserId = linkedUser.userId;
        }

        const subtotal      = parseFloat((amountNum / 1.15).toFixed(2));
        const iva           = parseFloat((amountNum - subtotal).toFixed(2));
        const invoiceNumber = await db.nextInvoiceNumber();
        const confirmedAt   = new Date().toISOString();
        const orderId       = 'ord_' + Date.now();

        const order = {
            id: orderId, token: crypto.randomBytes(16).toString('hex'),
            status: 'confirmado', userId: resolvedUserId,
            customerName:  customerName.trim().slice(0, 200),
            customerDoc:   customerDoc.trim().slice(0, 20),
            customerEmail: customerEmail.trim().slice(0, 200),
            concept:       concept.trim().slice(0, 300),
            amount: amountNum, subtotal, iva, ivaRate: 15,
            receiptUrl: null, notes: (notes || '').trim().slice(0, 500),
            paymentMonth: /^\d{4}-\d{2}$/.test(paymentMonth || '') ? paymentMonth : null,
            invoiceNumber, rejectionReason: '', formaPago: '01',
            createdAt: confirmedAt, confirmedAt
        };
        await db.createOrder(order);
        res.json({ ok: true, orderId, invoiceNumber });

        setImmediate(async () => {
            try {
                if (!getSRIConfig().ruc) return;
                const { result, invoiceNumber: usedInv } = await emitirConAutoRetry(order, invoiceNumber);
                const sriData = result.ok
                    ? { status: 'autorizado', claveAcceso: result.claveAcceso, numeroAutorizacion: result.numeroAutorizacion, fechaAutorizacion: result.fechaAutorizacion }
                    : { status: 'error', claveAcceso: result.claveAcceso || '', error: result.error };
                const fields = { sri: sriData };
                if (usedInv !== invoiceNumber) fields.invoiceNumber = usedInv;
                if (!result.ok) console.error('[SRI cash-invoice]', JSON.stringify(result));
                await db.updateOrder(orderId, fields);
            } catch (e) { console.error('[SRI cash-invoice setImmediate]', e); }
        });
    } catch (e) {
        console.error('[POST /api/orders/cash-invoice]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

/* ── List all orders (admin) ── */
router.get('/orders', async (req, res) => {
    try {
        if (!requireAdmin(req, res)) return;
        res.json((await db.getOrders()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    } catch (e) {
        console.error('[GET /api/orders]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

/* ── Student's own orders ── */
router.get('/my-orders', async (req, res) => {
    try {
        const sess = requireAuth(req, res);
        if (!sess) return;
        res.json(await db.getOrdersByUser(sess.userId));
    } catch (e) {
        console.error('[GET /api/my-orders]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

/* ── Orders by user (admin) — must be before /orders/:id ── */
router.get('/orders/by-user/:userId', async (req, res) => {
    try {
        if (!requireAdmin(req, res)) return;
        res.json(await db.getOrdersByUser(req.params.userId));
    } catch (e) {
        console.error('[GET /api/orders/by-user/:userId]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

/* ── Confirm order + trigger SRI ── */
router.put('/orders/:id/confirm', async (req, res) => {
    try {
        if (!requireAdmin(req, res)) return;
        const order = await db.getOrderById(req.params.id);
        if (!order) return res.status(404).json({ ok: false, message: 'Orden no encontrada' });
        if (order.status === 'confirmado') return res.json({ ok: true, invoiceNumber: order.invoiceNumber });

        const invoiceNumber = await db.nextInvoiceNumber();
        const confirmedAt   = new Date().toISOString();
        await db.updateOrder(req.params.id, { status: 'confirmado', invoiceNumber, confirmedAt });
        res.json({ ok: true, invoiceNumber });

        const orderId   = req.params.id;
        const orderSnap = { ...order, status: 'confirmado', invoiceNumber, confirmedAt };
        setImmediate(async () => {
            try {
                if (!getSRIConfig().ruc) return;
                const { result, invoiceNumber: usedInv } = await emitirConAutoRetry(orderSnap, invoiceNumber);
                const sriData = result.ok
                    ? { status: 'autorizado', claveAcceso: result.claveAcceso, numeroAutorizacion: result.numeroAutorizacion, fechaAutorizacion: result.fechaAutorizacion }
                    : { status: 'error', claveAcceso: result.claveAcceso || '', error: result.error };
                const fields = { sri: sriData };
                if (usedInv !== invoiceNumber) fields.invoiceNumber = usedInv;
                if (!result.ok) console.error('[SRI confirm]', JSON.stringify(result));
                await db.updateOrder(orderId, fields);
            } catch (e) {
                console.error('[SRI confirm error]', e.message);
                await db.updateOrder(orderId, { sri: { status: 'error', error: e.message } });
            }
            // Email al alumno — bloque separado para no afectar el resultado del SRI
            try {
                const updated = await db.getOrderById(orderId);
                if (updated && updated.sri && updated.sri.status === 'autorizado' && updated.customerEmail) {
                    const bankInfo  = await db.getBankInfo();
                    const facturaUrl = `${BASE_URL}/factura/${orderId}?token=${updated.token}`;
                    const facturaHtml = generateComprobanteHTML(updated, bankInfo);
                    await notifyEmail(
                        `Factura electronica autorizada — EXPRESART`,
                        `Hola ${updated.customerName},\n\nTu pago fue confirmado y el SRI autorizó tu factura electrónica.\n\nConcepto: ${updated.concept}\nMonto: $${parseFloat(updated.amount).toFixed(2)}\nFactura: ${updated.invoiceNumber}\n\nTambién puedes verla en línea:\n${facturaUrl}\n\nGracias,\nEXPRESART`,
                        _facturaEmailHtml(updated, facturaUrl),
                        updated.customerEmail,
                        [{ filename: `factura-${updated.invoiceNumber}.html`, content: Buffer.from(facturaHtml).toString('base64') }]
                    );
                }
            } catch (e) {
                console.error('[Email factura error]', e.message);
            }
        });
    } catch (e) {
        console.error('[PUT /api/orders/:id/confirm]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

/* ── SRI retry ── */
router.post('/orders/:id/sri-retry', async (req, res) => {
    try {
        if (!requireAdmin(req, res)) return;
        const order = await db.getOrderById(req.params.id);
        if (!order) return res.status(404).json({ ok: false, message: 'Orden no encontrada' });
        if (order.status !== 'confirmado')
            return res.status(400).json({ ok: false, message: 'Solo se puede reintentar en órdenes confirmadas' });

        const startSeq = invoiceFromSeq(seqFromInvoice(order.invoiceNumber) + 1);
        await db.updateOrder(req.params.id, { invoiceNumber: startSeq });
        res.json({ ok: true, message: 'Reintento iniciado' });

        const orderId   = req.params.id;
        const orderSnap = { ...order, invoiceNumber: startSeq, confirmedAt: new Date().toISOString() };
        setImmediate(async () => {
            try {
                const { result, invoiceNumber: usedInv } = await emitirConAutoRetry(orderSnap, startSeq);
                const sriData = result.ok
                    ? { status: 'autorizado', claveAcceso: result.claveAcceso, numeroAutorizacion: result.numeroAutorizacion, fechaAutorizacion: result.fechaAutorizacion }
                    : { status: 'error', claveAcceso: result.claveAcceso || '', error: result.error };
                const fields = { sri: sriData };
                if (usedInv !== startSeq) fields.invoiceNumber = usedInv;
                await db.updateOrder(orderId, fields);
            } catch (e) {
                await db.updateOrder(orderId, { sri: { status: 'error', error: e.message } });
            }
            try {
                const updated = await db.getOrderById(orderId);
                if (updated && updated.sri && updated.sri.status === 'autorizado' && updated.customerEmail) {
                    const bankInfo   = await db.getBankInfo();
                    const facturaUrl = `${BASE_URL}/factura/${orderId}?token=${updated.token}`;
                    const facturaHtml = generateComprobanteHTML(updated, bankInfo);
                    await notifyEmail(
                        `Factura electronica autorizada — EXPRESART`,
                        `Hola ${updated.customerName},\n\nTu pago fue confirmado y el SRI autorizó tu factura electrónica.\n\nConcepto: ${updated.concept}\nMonto: $${parseFloat(updated.amount).toFixed(2)}\nFactura: ${updated.invoiceNumber}\n\nTambién puedes verla en línea:\n${facturaUrl}\n\nGracias,\nEXPRESART`,
                        _facturaEmailHtml(updated, facturaUrl),
                        updated.customerEmail,
                        [{ filename: `factura-${updated.invoiceNumber}.html`, content: Buffer.from(facturaHtml).toString('base64') }]
                    );
                }
            } catch (e) {
                console.error('[Email factura error]', e.message);
            }
        });
    } catch (e) {
        console.error('[POST /api/orders/:id/sri-retry]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

/* ── Reject order ── */
router.put('/orders/:id/reject', async (req, res) => {
    try {
        if (!requireAdmin(req, res)) return;
        const order = await db.getOrderById(req.params.id);
        if (!order) return res.status(404).json({ ok: false, message: 'Orden no encontrada' });
        await db.updateOrder(req.params.id, {
            status: 'rechazado',
            rejectionReason: (req.body.reason || '').trim().slice(0, 300)
        });
        res.json({ ok: true });
    } catch (e) {
        console.error('[PUT /api/orders/:id/reject]', e);
        res.status(500).json({ ok: false, message: 'Error interno' });
    }
});

/* ── P12 certificate upload ── */
const path = require('path');
const fs   = require('fs');
const { DATA_DIR } = require('../db');
const { uploader: _up } = require('../middleware/upload');

router.post('/p12-upload', (req, res) => {
    if (!requireAdmin(req, res)) return;
    _up.single('p12')(req, res, (err) => {
        if (err) return res.status(400).json({ ok: false, message: err.message });
        if (!req.file) return res.status(400).json({ ok: false, message: 'No se recibió el archivo' });
        const dest = path.join(DATA_DIR, '.p12');
        fs.writeFileSync(dest, req.file.buffer, { mode: 0o600 });
        res.json({ ok: true, message: 'Certificado .p12 guardado correctamente' });
    });
});

/* ── Comprobante HTML (accessible by admin via signed URL, or student via order token) ──
   Access methods:
     1. ?sv=SIGNED_TOKEN   — admin, short-lived HMAC token (recommended)
     2. ?token=ORDER_TOKEN — student/share, per-order token
     3. Session in header  — admin browsing via API (e.g., from /api/auth check)
*/
router.get('/factura/:id', async (req, res) => {
    try {
        const order = await db.getOrderById(req.params.id);
        if (!order) return res.status(404).send('<h2>Comprobante no encontrado</h2>');

        const resourcePath = '/factura/' + req.params.id;
        const cookieSess   = getSession(req);
        const isAdmin      = cookieSess && cookieSess.role === 'admin';

        const authorizedViaSignedToken = req.query.sv && verifyViewPath(resourcePath, req.query.sv);
        const authorizedViaOrderToken  = req.query.token === order.token;

        if (!isAdmin && !authorizedViaSignedToken && !authorizedViaOrderToken)
            return res.status(403).send('<h2>Acceso no autorizado</h2>');
        if (order.status !== 'confirmado')
            return res.status(400).send('<h2>El pago aún no ha sido confirmado por EXPRESART.</h2>');

        const info = await db.getBankInfo();
        res.send(generateComprobanteHTML(order, info));
    } catch (e) {
        console.error('[GET /factura/:id]', e);
        res.status(500).send('<h2>Error interno</h2>');
    }
});

/* ── Resetear secuencial: limpiar números fantasma no autorizados por SRI ── */
router.post('/orders/reset-invoice-seq', async (req, res) => {
    try {
        if (!requireAdmin(req, res)) return;
        const { lastSriSeq } = req.body;
        const threshold = parseInt(lastSriSeq, 10);
        if (!threshold || threshold < 1)
            return res.status(400).json({ ok: false, message: 'lastSriSeq inválido' });

        const orders = await db.getOrders();
        let cleared = 0;
        for (const o of orders) {
            if (!o.invoiceNumber) continue;
            const seq = seqFromInvoice(o.invoiceNumber);
            if (seq <= threshold) continue;
            const sriOk = o.sri && o.sri.status === 'autorizado';
            if (sriOk) continue;
            await db.updateOrder(o.id, { invoiceNumber: null });
            cleared++;
        }
        const next = await db.nextInvoiceNumber();
        res.json({ ok: true, cleared, nextInvoiceNumber: next,
            message: `${cleared} número(s) fantasma limpiados. Próxima factura: ${next}` });
    } catch (e) {
        console.error('[POST /api/orders/reset-invoice-seq]', e);
        res.status(500).json({ ok: false, message: e.message });
    }
});

module.exports = router;
