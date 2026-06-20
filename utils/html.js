'use strict';

function htmlEncode(s) {
    return String(s || '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

const emptyProfile = (userId) => ({
    userId, displayName: '', bio: '', bio_short: '',
    photoUrl: '', especialidades: [], producciones: [], videos: [], certificados: []
});

function generateComprobanteHTML(order, info) {
    const fecha = new Date(order.confirmedAt).toLocaleDateString('es-EC',
        { timeZone: 'America/Guayaquil', year: 'numeric', month: 'long', day: 'numeric' });
    const sri = order.sri || {};
    const sriBlock = sri.status === 'autorizado';

    const formaPagoText = order.formaPago === '01'
        ? 'Efectivo'
        : `Transferencia bancaria · <strong>${htmlEncode(info.bankName || '')}</strong> · ${htmlEncode(info.accountType || '')} No. <strong>${htmlEncode(info.accountNumber || '')}</strong>`;

    return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Comprobante ${htmlEncode(order.invoiceNumber || '')} — EXPRESART</title>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;600;700&family=Playfair+Display:wght@700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Poppins',sans-serif;background:#060002;color:rgba(255,220,220,0.88);min-height:100vh;padding:40px 16px}
.wrap{max-width:720px;margin:0 auto}
.header{text-align:center;margin-bottom:36px}
.header img{height:72px;margin-bottom:14px}
.header h1{font-family:'Playfair Display',serif;font-size:1.6em;color:#fff;letter-spacing:1px}
.header .sub{font-size:0.78em;color:#c9a227;letter-spacing:2px;text-transform:uppercase;margin-top:4px}
.divider{height:1px;background:linear-gradient(90deg,transparent,#c9a227,transparent);margin:24px 0}
.card{background:rgba(255,255,255,0.04);border:1px solid rgba(201,162,39,0.25);border-radius:12px;padding:20px 24px;margin-bottom:16px}
.card h3{font-size:0.72em;text-transform:uppercase;letter-spacing:2px;color:#c9a227;margin-bottom:14px}
table{width:100%;border-collapse:collapse}
td{padding:8px 4px;border-bottom:1px solid rgba(255,255,255,0.06);font-size:0.88em;vertical-align:top}
td:first-child{color:rgba(255,200,200,0.5);width:45%;padding-right:12px}
td:last-child{color:#fff;font-weight:500}
.totals td{border-bottom:none;padding:5px 4px}
.totals td:first-child{color:rgba(255,200,200,0.45)}
.total-final td{border-top:1px solid rgba(201,162,39,0.4);padding-top:12px;margin-top:4px;font-size:1.05em;font-weight:700;color:#c9a227}
.badge{display:inline-block;background:rgba(94,214,94,0.12);color:#7ed97e;border:1px solid rgba(94,214,94,0.3);border-radius:20px;padding:2px 12px;font-size:0.82em;font-weight:600}
.sri-box{background:rgba(201,162,39,0.07);border:1px solid rgba(201,162,39,0.3);border-radius:12px;padding:20px 24px;margin-bottom:16px}
.sri-box h3{font-size:0.72em;text-transform:uppercase;letter-spacing:2px;color:#c9a227;margin-bottom:14px}
.sri-box td{font-size:0.82em}
.sri-box td:last-child{font-family:monospace;word-break:break-all;font-size:0.78em}
.footer{text-align:center;margin-top:40px;font-size:0.76em;color:rgba(255,200,200,0.35);line-height:1.8}
.footer strong{color:rgba(201,162,39,0.7)}
@media print{body{background:#fff;color:#222}
.card,.sri-box{border-color:#ddd;background:#fafafa}
.header h1,.total-final td{color:#222}
.card h3,.sri-box h3,.footer strong{color:#8b0000}
td:first-child{color:#666}td:last-child{color:#111}
.badge{color:#2a7a2a;background:#eaffea;border-color:#2a7a2a}
.divider{background:#ccc}}
</style></head><body>
<div class="wrap">
  <div class="header">
    <img src="/logo.png" alt="EXPRESART">
    <h1>Comprobante de Pago</h1>
    <div class="sub">Escuela de Actuación · Donde el Arte Cobra Vida</div>
  </div>
  <div class="divider"></div>

  <div class="card">
    <h3>Información del comprobante</h3>
    <table>
      <tr><td>N° Comprobante</td><td>${htmlEncode(order.invoiceNumber || '—')}</td></tr>
      <tr><td>Fecha</td><td>${fecha}</td></tr>
      <tr><td>Estado</td><td><span class="badge">✓ Pago confirmado</span></td></tr>
    </table>
  </div>

  <div class="card">
    <h3>Datos del cliente</h3>
    <table>
      <tr><td>Nombre</td><td>${htmlEncode(order.customerName)}</td></tr>
      <tr><td>Documento</td><td>${htmlEncode(order.customerDoc)}</td></tr>
      <tr><td>Email</td><td>${htmlEncode(order.customerEmail)}</td></tr>
    </table>
  </div>

  <div class="card">
    <h3>Detalle del pago</h3>
    <table>
      <tr><td>${htmlEncode(order.concept)}</td><td style="text-align:right">$${order.amount.toFixed(2)}</td></tr>
    </table>
  </div>

  <div class="card">
    <h3>Resumen</h3>
    <table class="totals">
      <tr><td>Subtotal (tarifa ${order.ivaRate || 15}% IVA)</td><td style="text-align:right">$${order.subtotal.toFixed(2)}</td></tr>
      <tr><td>IVA ${order.ivaRate || 15}%</td><td style="text-align:right">$${order.iva.toFixed(2)}</td></tr>
      <tr class="total-final"><td>TOTAL PAGADO</td><td style="text-align:right">$${order.amount.toFixed(2)}</td></tr>
    </table>
  </div>

  <div class="card">
    <h3>Forma de pago</h3>
    <table><tr><td style="width:45%">Método</td><td>${formaPagoText}</td></tr></table>
  </div>

  ${sriBlock ? `<div class="sri-box"><h3>Factura Electrónica — SRI</h3><table>
    <tr><td>Clave de acceso</td><td>${htmlEncode(sri.claveAcceso || '')}</td></tr>
    <tr><td>N° Autorización</td><td>${htmlEncode(sri.numeroAutorizacion || '')}</td></tr>
    <tr><td>Fecha autorización</td><td>${htmlEncode(sri.fechaAutorizacion || '')}</td></tr>
  </table></div>` : ''}

  <div class="divider"></div>
  <div class="footer">
    <p>Este comprobante es un documento de respaldo de pago.</p>
    <p>La factura electrónica autorizada por el SRI ha sido registrada con los datos indicados.</p>
    <br><strong>EXPRESART — Escuela de Actuación · Donde el Arte Cobra Vida</strong>
  </div>
</div>
</body></html>`;
}

module.exports = { htmlEncode, emptyProfile, generateComprobanteHTML };
