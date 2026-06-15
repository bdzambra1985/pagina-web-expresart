'use strict';
const crypto  = require('crypto');
const router  = require('express').Router();
const db      = require('../db');
const { requireAuth, requireAdmin, getSessionByRawToken } = require('../middleware/auth');
const { uploader, saveFile, detectMime, ALLOWED_MIMES_RECEIPT } = require('../middleware/upload');
const { emitirFactura, getSRIConfig }  = require('../sri/index');
const { notifyEmail }                  = require('../utils/notify');
const { htmlEncode, generateComprobanteHTML } = require('../utils/html');
const { verifyViewPath }               = require('../utils/crypto');

/* ── Helpers ── */
function seqFromInvoice(inv) {
    return parseInt((inv || '001-001-000000000').split('-').pop(), 10) || 0;
}
function invoiceFromSeq(n) {
    return '001-001-' + String(n).padStart(9, '0');
}

async function emitirConAutoRetry(orderSnap, startSecuencial, maxAttempts = 15) {
    let seq = seqFromInvoice(startSecuencial);
    let result;
    for (let i = 0; i < maxAttempts; i++) {
        const inv = invoiceFromSeq(seq);
        result = await emitirFactura(orderSnap, inv);
        if (result.ok) return { result, invoiceNumber: inv };
        if (!result.error || !result.error.includes('SECUENCIAL REGISTRADO'))
            return { result, invoiceNumber: inv };
        console.log(`Secuencial ${inv} ya registrado en SRI, probando ${invoiceFromSeq(seq + 1)}…`);
        seq++;
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
router.post('/orders', (req, res) => {
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

            // Link to student session if present
            let linkedUserId = null;
            const rawSessTok = req.headers['x-session-token'];
            if (rawSessTok) {
                const sess = getSessionByRawToken(rawSessTok);
                if (sess && sess.role === 'alumno') linkedUserId = sess.userId;
            }

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

            notifyEmail(
                `💰 Nuevo pago pendiente — ${order.customerName}`,
                `Se recibió un comprobante de pago en EXPRESART.\n\n` +
                `Alumno:  ${order.customerName}\n` +
                `Email:   ${order.customerEmail}\n` +
                `Cédula:  ${order.customerDoc}\n` +
                `Concepto: ${order.concept}\n` +
                `Monto:   $${parseFloat(order.amount).toFixed(2)}\n` +
                `Mes:     ${order.paymentMonth || 'Sin especificar'}\n` +
                `Ref:     ${order.id}\n\n` +
                `Revisa el panel de administración para aprobar o rechazar el pago.`
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
        const headerSess   = req.headers['x-session-token'];
        const adminSess    = headerSess ? require('../middleware/auth').getSessionByRawToken(headerSess) : null;
        const isAdmin      = adminSess && adminSess.role === 'admin';

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

module.exports = router;
