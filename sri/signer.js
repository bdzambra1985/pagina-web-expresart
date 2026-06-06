'use strict';

/**
 * SRI Ecuador — Firmador XAdES-BES con node-forge
 *
 * Firma un XML de factura con un certificado .p12 y devuelve el XML firmado.
 * Implementación simplificada compatible con el SRI Ecuador.
 */

const forge = require('node-forge');

/**
 * Construye el DN (Distinguished Name) del emisor del certificado.
 * @param {object} certIssuer  forge certificate issuer object
 * @returns {string}
 */
function buildIssuerDN(certIssuer) {
    const order = ['CN', 'OU', 'O', 'L', 'ST', 'C'];
    const parts = [];
    // Primero los atributos en el orden preferido
    for (const shortName of order) {
        const attr = certIssuer.attributes.find(a => a.shortName === shortName);
        if (attr) parts.push(`${shortName}=${attr.value}`);
    }
    // Luego cualquier otro atributo no listado
    for (const attr of certIssuer.attributes) {
        if (!order.includes(attr.shortName)) {
            parts.push(`${(attr.shortName || attr.type)}=${attr.value}`);
        }
    }
    return parts.join(', ');
}

/**
 * Convierte bytes de node-forge a Buffer Node.js.
 * @param {string} forgeBytes  Bytes en formato forge (latin1)
 * @returns {Buffer}
 */
function forgeBytesToBuffer(forgeBytes) {
    return Buffer.from(forgeBytes, 'binary');
}

/**
 * Calcula SHA1 digest de un string y lo devuelve como base64.
 * @param {string} data
 * @returns {string}
 */
function sha1Base64(data) {
    const md = forge.md.sha1.create();
    md.update(data, 'utf8');
    return forgeBytesToBuffer(md.digest().bytes()).toString('base64');
}

/**
 * Elimina la declaración XML <?xml...?> si existe.
 * @param {string} xml
 * @returns {string}
 */
function stripXmlDeclaration(xml) {
    return xml.replace(/^<\?xml[^?]*\?>\s*/i, '');
}

/**
 * Firma un XML de factura con XAdES-BES usando RSA-SHA1.
 *
 * @param {string} xmlContent    XML original (puede incluir <?xml...?>)
 * @param {Buffer} p12Buffer     Certificado .p12 como Buffer
 * @param {string} p12Password   Contraseña del certificado
 * @returns {string}             XML firmado con <ds:Signature> inyectado
 */
function signXML(xmlContent, p12Buffer, p12Password) {
    // Parsear el .p12
    const p12Der  = forge.util.createBuffer(p12Buffer.toString('binary'));
    const p12Asn1 = forge.asn1.fromDer(p12Der);
    const p12     = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, p12Password);

    // Extraer clave privada
    const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
    const keyBag  = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag]
        || p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag];
    if (!keyBag || !keyBag[0]) throw new Error('No se encontró clave privada en el .p12');
    const privateKey = keyBag[0].key;

    // Extraer certificado de entidad final (el primero en certBags o el leaf)
    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag];
    if (!certBags || !certBags.length) throw new Error('No se encontró certificado en el .p12');

    // El certificado de entidad final suele ser el último (o el único)
    const cert = certBags[certBags.length - 1].cert || certBags[0].cert;

    // Datos del certificado
    const certDer        = forge.pki.certificateToDer(cert);
    const certBase64     = forgeBytesToBuffer(certDer.bytes()).toString('base64');
    const issuerDN       = buildIssuerDN(cert.issuer);
    const serialNumber   = cert.serialNumber;

    // Digest SHA1 del certificado (para SignedProperties)
    const certDigestB64  = sha1Base64(forge.util.decode64(certBase64).length > 0
        ? forge.pki.certificateToDer(cert).bytes()  // usar bytes binarios
        : certBase64);

    // Calcular digest del certificado correctamente (binario, no utf8)
    const certMd = forge.md.sha1.create();
    certMd.update(certDer.bytes());
    const certDigestBase64 = forgeBytesToBuffer(certMd.digest().bytes()).toString('base64');

    // IDs únicos para los elementos de firma
    const sigId         = 'Signature-' + Date.now();
    const sigPropsId    = 'SignedProperties-' + sigId;
    const keyInfoId     = 'KeyInfo-' + sigId;
    const sigObjId      = 'SignedObject-' + sigId;
    const signingTime   = new Date().toISOString();

    // 1) Preparar el contenido del documento (sin declaración XML)
    const xmlStripped = stripXmlDeclaration(xmlContent);

    // 2) Calcular digest del documento (Reference URI="" → todo el documento sin Signature)
    const docDigestB64 = sha1Base64(xmlStripped);

    // 3) Construir SignedProperties (para calcular su digest)
    const signedPropsContent = `<xades:SignedProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Id="${sigPropsId}"><xades:SignedSignatureProperties><xades:SigningTime>${signingTime}</xades:SigningTime><xades:SigningCertificate><xades:Cert><xades:CertDigest><ds:DigestMethod xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/><ds:DigestValue xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${certDigestBase64}</ds:DigestValue></xades:CertDigest><xades:IssuerSerial><ds:X509IssuerName xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${issuerDN}</ds:X509IssuerName><ds:X509SerialNumber xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${serialNumber}</ds:X509SerialNumber></xades:IssuerSerial></xades:Cert></xades:SigningCertificate></xades:SignedSignatureProperties></xades:SignedProperties>`;

    const signedPropsDigestB64 = sha1Base64(signedPropsContent);

    // 4) Construir SignedInfo
    const signedInfoContent = `<ds:SignedInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/><ds:SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"/><ds:Reference URI=""><ds:Transforms><ds:Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/></ds:Transforms><ds:DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/><ds:DigestValue>${docDigestB64}</ds:DigestValue></ds:Reference><ds:Reference URI="#${sigPropsId}" Type="http://uri.etsi.org/01903#SignedProperties"><ds:DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"/><ds:DigestValue>${signedPropsDigestB64}</ds:DigestValue></ds:Reference></ds:SignedInfo>`;

    // 5) Firmar SignedInfo con RSA-SHA1
    const signedInfoMd = forge.md.sha1.create();
    signedInfoMd.update(signedInfoContent, 'utf8');
    const signatureBytes  = privateKey.sign(signedInfoMd);
    const signatureValue  = forgeBytesToBuffer(signatureBytes).toString('base64');

    // 6) Construir el bloque <ds:Signature> completo
    const signatureBlock = `<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Id="${sigId}">
  ${signedInfoContent}
  <ds:SignatureValue Id="SignatureValue-${sigId}">${signatureValue}</ds:SignatureValue>
  <ds:KeyInfo Id="${keyInfoId}">
    <ds:X509Data>
      <ds:X509Certificate>${certBase64}</ds:X509Certificate>
    </ds:X509Data>
  </ds:KeyInfo>
  <ds:Object Id="${sigObjId}">
    <xades:QualifyingProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Target="#${sigId}">
      ${signedPropsContent}
    </xades:QualifyingProperties>
  </ds:Object>
</ds:Signature>`;

    // 7) Inyectar <ds:Signature> antes de </factura>
    if (!xmlStripped.includes('</factura>')) {
        throw new Error('No se encontró la etiqueta </factura> en el XML');
    }

    return xmlStripped.replace('</factura>', signatureBlock + '\n</factura>');
}

module.exports = { signXML };
