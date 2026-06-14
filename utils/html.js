'use strict';

function htmlEncode(s) {
    return String(s || '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

const emptyProfile = (userId) => ({
    userId, displayName: '', bio: '', bio_short: '',
    photoUrl: '', especialidades: [], producciones: [], videos: []
});

function generateComprobanteHTML(order, info) {
    const fecha = new Date(order.confirmedAt).toLocaleDateString('es-EC',
        { timeZone: 'America/Guayaquil', year: 'numeric', month: 'long', day: 'numeric' });
    const sri = order.sri || {};
    const sriBlock = sri.status === 'autorizado' ? `
<div class="section">
  <h3>Factura Electrónica — SRI</h3>
  <p><strong>Clave de acceso:</strong> <span style="font-size:0.78em;word-break:break-all;font-family:monospace">${htmlEncode(sri.claveAcceso || '')}</span></p>
  <p><strong>Número de autorización:</strong> ${htmlEncode(sri.numeroAutorizacion || '')}</p>
  <p><strong>Fecha autorización:</strong> ${htmlEncode(sri.fechaAutorizacion || '')}</p>
</div>` : '';

    const formaPagoText = order.formaPago === '01'
        ? 'Efectivo'
        : `Transferencia bancaria · <strong>${htmlEncode(info.bankName || '')}</strong> · ${htmlEncode(info.accountType || '')} No. <strong>${htmlEncode(info.accountNumber || '')}</strong>`;

    return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<title>Comprobante ${htmlEncode(order.invoiceNumber || '')}</title>
<style>
body{font-family:Arial,sans-serif;color:#222;max-width:780px;margin:40px auto;padding:0 20px}
h1{color:#8b0000;border-bottom:2px solid #8b0000;padding-bottom:8px}
h3{color:#555;margin:0 0 8px}
.section{margin:20px 0;padding:16px;border:1px solid #ddd;border-radius:6px}
table{width:100%;border-collapse:collapse}
td,th{padding:8px 10px;border-bottom:1px solid #eee;text-align:left}
th{background:#f5f5f5;font-size:0.82em;text-transform:uppercase;letter-spacing:1px}
.totals td{border-bottom:none;padding:4px 10px}
.total-final td{font-weight:bold;font-size:1.05em;border-top:2px solid #222;padding-top:10px}
.footer{margin-top:40px;font-size:0.78em;color:#888;text-align:center}
</style></head><body>
<h1>EXPRESART — Comprobante de Pago</h1>
<div class="section">
  <table>
    <tr><td><strong>No. Comprobante</strong></td><td>${htmlEncode(order.invoiceNumber || '')}</td></tr>
    <tr><td><strong>Fecha</strong></td><td>${fecha}</td></tr>
    <tr><td><strong>Estado</strong></td><td>✅ Pago confirmado</td></tr>
  </table>
</div>
<div class="section">
  <h3>Datos del cliente</h3>
  <table>
    <tr><td><strong>Nombre</strong></td><td>${htmlEncode(order.customerName)}</td></tr>
    <tr><td><strong>Documento</strong></td><td>${htmlEncode(order.customerDoc)}</td></tr>
    <tr><td><strong>Email</strong></td><td>${htmlEncode(order.customerEmail)}</td></tr>
  </table>
</div>
<div class="section">
  <h3>Detalle del pago</h3>
  <table>
    <thead><tr><th>Concepto</th><th style="text-align:right">Monto</th></tr></thead>
    <tbody>
      <tr><td>${htmlEncode(order.concept)}</td><td style="text-align:right">$${order.amount.toFixed(2)}</td></tr>
    </tbody>
  </table>
</div>
<div class="section">
  <table class="totals">
    <tr><td style="color:#666">Subtotal (tarifa ${order.ivaRate || 15}% IVA)</td><td style="text-align:right">$${order.subtotal.toFixed(2)}</td></tr>
    <tr><td style="color:#666">IVA ${order.ivaRate || 15}%</td><td style="text-align:right">$${order.iva.toFixed(2)}</td></tr>
    <tr class="total-final"><td>TOTAL PAGADO</td><td style="text-align:right">$${order.amount.toFixed(2)}</td></tr>
  </table>
</div>
<div class="section">
  <h3>Forma de pago</h3>
  <p>${formaPagoText}</p>
</div>
${sriBlock}
<div class="footer">
  <p>Este comprobante es un documento de respaldo de pago.</p>
  <p>La factura electrónica autorizada por el SRI ha sido registrada con los datos indicados.</p>
  <p><strong>EXPRESART — Escuela de Actuación · Donde el Arte Cobra Vida</strong></p>
</div>
</body></html>`;
}

module.exports = { htmlEncode, emptyProfile, generateComprobanteHTML };
