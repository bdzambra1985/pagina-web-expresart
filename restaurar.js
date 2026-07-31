#!/usr/bin/env node
'use strict';
/**
 * restaurar.js — Restaura un respaldo de EXPRESART en la base de datos.
 *
 *   node restaurar.js <archivo|nombre-en-R2> [--dry-run] [--si]
 *
 * Es deliberadamente un script de consola y no un botón del panel: restaurar
 * sobrescribe datos, y eso no debe estar a un clic de distancia en una
 * pestaña del navegador.
 *
 * Protecciones:
 *   1. Por defecto hace una simulación (--dry-run) que no toca nada.
 *   2. Antes de escribir, guarda un respaldo del estado actual. Restaurar
 *      nunca es un viaje sin retorno.
 *   3. Pide confirmación escrita salvo que se pase --si.
 *   4. Valida la estructura del respaldo antes de empezar.
 */
require('dotenv').config({ quiet: true });

const fs       = require('fs');
const path     = require('path');
const zlib     = require('zlib');
const readline = require('readline');

const db = require('./db');
const { decryptBackup, getBackupStream, runBackup } = require('./utils/backup');

/* ── Argumentos ── */
const args    = process.argv.slice(2);
const origen  = args.find(a => !a.startsWith('--'));
const aplicar = args.includes('--aplicar') || args.includes('--apply');
const dryRun  = !aplicar;
const autoSi  = args.includes('--si') || args.includes('--yes');

if (!origen) {
    console.error(`
Uso:  node restaurar.js <archivo|nombre-en-R2> [--aplicar] [--si]

  <archivo>    Ruta a un .json.gz descargado, o el nombre de un respaldo
               guardado en R2 (backup-YYYY-MM-DDTHH-MM-SS.json.gz).

  --aplicar    Escribe de verdad. Sin esta bandera solo simula.
  --si         No preguntar confirmación (para automatizar).

Ejemplos:
  node restaurar.js backup-2026-07-31T20-16-46.json.gz
  node restaurar.js ~/Descargas/backup-2026-07-31T20-16-46.json.gz --aplicar
`);
    process.exit(1);
}

/* ── Utilidades ── */
function pregunta(texto) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(res => rl.question(texto, r => { rl.close(); res(r.trim()); }));
}

/* Lee el respaldo desde disco o desde R2, descifrando si hace falta. */
async function cargarSnapshot(origen) {
    let bruto;

    if (fs.existsSync(origen)) {
        console.log(`  Leyendo de disco: ${path.resolve(origen)}`);
        bruto = fs.readFileSync(origen);
    } else {
        console.log(`  No existe como archivo local. Buscando en el almacenamiento remoto: ${origen}`);
        const stream = await getBackupStream(origen);
        if (!stream) throw new Error(`No se encontró el respaldo "${origen}" ni en disco ni en R2.`);
        const trozos = [];
        for await (const t of stream) trozos.push(t);
        bruto = Buffer.concat(trozos);
        // getBackupStream ya devuelve el contenido descifrado.
        return JSON.parse(zlib.gunzipSync(bruto));
    }

    // Un archivo de disco puede venir cifrado (bajado de R2 a mano) o no.
    const plano = decryptBackup(bruto);
    return JSON.parse(zlib.gunzipSync(plano));
}

/* Comprueba que el respaldo tenga la forma esperada antes de tocar nada. */
function validar(snap) {
    const problemas = [];
    if (!snap || typeof snap !== 'object')       problemas.push('el archivo no contiene un objeto JSON');
    if (!snap?.tables || typeof snap.tables !== 'object') problemas.push('falta la clave "tables"');
    if (!snap?.exportedAt)                        problemas.push('falta "exportedAt"');

    const esperadas = ['users', 'events', 'orders', 'bankInfo', 'shareLinks', 'resetRequests'];
    for (const t of esperadas) {
        if (snap?.tables && !Array.isArray(snap.tables[t]))
            problemas.push(`la tabla "${t}" falta o no es una lista`);
    }
    if (snap?.tables?.users && snap.tables.users.length === 0)
        problemas.push('no hay ningún usuario — un respaldo sin usuarios es sospechoso');

    return problemas;
}

/* ── Escritura, tabla por tabla ── */
async function restaurar(tablas) {
    const hechos = {};

    // users: se actualiza si existe, se crea si no. Nunca se borran usuarios
    // que no estén en el respaldo — borrar es irreversible y no es lo que
    // espera quien restaura para recuperar algo puntual.
    let nuevos = 0, actualizados = 0;
    for (const u of tablas.users || []) {
        const existe = await db.getUserById(u.userId);
        if (existe) {
            await db.updateUser(u.userId, {
                passwordHash: u.passwordHash, active: u.active,
                mustChangePassword: u.mustChangePassword, displayName: u.displayName,
                consentAcceptedAt: u.consentAcceptedAt,
                totpSecret: u.totpSecret ?? null,
                totpEnabled: !!u.totpEnabled,
                totpRecovery: u.totpRecovery || []
            });
            actualizados++;
        } else {
            await db.createUser(u);
            nuevos++;
        }
    }
    hechos.users = `${nuevos} creados, ${actualizados} actualizados`;

    for (const p of tablas.profiles || []) await db.upsertProfile(p.userId, p);
    hechos.profiles = `${(tablas.profiles || []).length} restaurados`;

    // events: se recrean los que falten (createEvent no pisa los existentes).
    const eventosActuales = new Set((await db.getEvents()).map(e => e.id));
    let ev = 0;
    for (const e of tablas.events || []) {
        if (!eventosActuales.has(e.id)) { await db.createEvent(e); ev++; }
    }
    hechos.events = `${ev} añadidos (${eventosActuales.size} ya estaban)`;

    const content = (tablas.content || [])[0] || {};
    for (const [seccion, valor] of Object.entries(content)) {
        await db.saveContentSection(seccion, valor);
    }
    hechos.content = `${Object.keys(content).length} secciones`;

    const pedidosActuales = new Set((await db.getOrders()).map(o => o.id));
    let ped = 0;
    for (const o of tablas.orders || []) {
        if (!pedidosActuales.has(o.id)) { await db.createOrder(o); ped++; }
    }
    hechos.orders = `${ped} añadidos (${pedidosActuales.size} ya estaban)`;

    const banco = (tablas.bankInfo || [])[0];
    if (banco) await db.saveBankInfo(banco);
    hechos.bankInfo = banco ? 'restaurado' : 'no había';

    const enlacesActuales = new Set((await db.getShareLinks()).map(l => l.shareId));
    let en = 0;
    for (const l of tablas.shareLinks || []) {
        if (!enlacesActuales.has(l.shareId)) { await db.createShareLink(l); en++; }
    }
    hechos.shareLinks = `${en} añadidos`;

    const solicitudesActuales = new Set((await db.getResetRequests()).map(r => r.id));
    let so = 0;
    for (const r of tablas.resetRequests || []) {
        if (!solicitudesActuales.has(r.id)) { await db.createResetRequest(r); so++; }
    }
    hechos.resetRequests = `${so} añadidas`;

    const mensajesActuales = new Set((await db.getPrivacyMessages()).map(m => m.id));
    let me = 0;
    for (const m of tablas.privacyMessages || []) {
        if (!mensajesActuales.has(m.id)) { await db.createPrivacyMessage(m); me++; }
    }
    hechos.privacyMessages = `${me} añadidos`;

    return hechos;
}

/* ── Programa principal ── */
(async () => {
    try {
        console.log('\n══ RESTAURACIÓN DE RESPALDO — EXPRESART ══\n');

        await db.initDB();
        console.log(`  Destino: ${db.USE_DB ? 'PostgreSQL (DATABASE_URL)' : 'archivos JSON en data/'}`);

        const snap = await cargarSnapshot(origen);

        const problemas = validar(snap);
        if (problemas.length) {
            console.error('\n  ✗ El respaldo no pasó la validación:');
            problemas.forEach(p => console.error('    -', p));
            process.exit(1);
        }

        const t = snap.tables;
        console.log(`\n  Respaldo del : ${snap.exportedAt}`);
        console.log(`  Formato      : v${snap.version || 1}` +
                    (Number(snap.version) < 2 ? '  ← antiguo: no incluye perfiles, contenido ni bandeja de privacidad' : ''));
        console.log('\n  Contenido:');
        const filas = [
            ['usuarios',              t.users],
            ['perfiles',              t.profiles],
            ['eventos',               t.events],
            ['contenido (secciones)', t.content && t.content[0] ? Object.keys(t.content[0]) : []],
            ['pedidos',               t.orders],
            ['datos bancarios',       t.bankInfo],
            ['enlaces compartidos',   t.shareLinks],
            ['solicitudes de reseteo',t.resetRequests],
            ['mensajes de privacidad',t.privacyMessages],
        ];
        for (const [nombre, val] of filas) {
            const n = Array.isArray(val) ? val.length : 0;
            console.log(`    ${String(n).padStart(5)}  ${nombre}${(!val && Number(snap.version) < 2) ? '  (no estaba en este formato)' : ''}`);
        }

        if (dryRun) {
            console.log('\n  ── SIMULACIÓN ── No se ha escrito nada.');
            console.log('  Para aplicarlo de verdad, repite el comando con  --aplicar\n');
            process.exit(0);
        }

        console.log('\n  ⚠  Esto va a SOBRESCRIBIR datos de la base actual.');
        if (!autoSi) {
            const r = await pregunta('  Escribe RESTAURAR para continuar: ');
            if (r !== 'RESTAURAR') {
                console.log('  Cancelado. No se tocó nada.\n');
                process.exit(0);
            }
        }

        // Red de seguridad: copia del estado actual antes de sobrescribirlo.
        console.log('\n  Guardando un respaldo del estado ACTUAL antes de tocar nada…');
        const previo = await runBackup();
        if (!previo.ok) {
            console.error('  ✗ No se pudo respaldar el estado actual:', previo.error);
            console.error('    Se aborta: restaurar sin red de seguridad no es aceptable.');
            process.exit(1);
        }
        console.log(`  ✓ Estado actual guardado como ${previo.filename}`);
        console.log('    (si algo sale mal, restaura ESE archivo)\n');

        console.log('  Restaurando…');
        const hechos = await restaurar(t);
        for (const [tabla, resultado] of Object.entries(hechos)) {
            console.log(`    ${tabla.padEnd(18)} ${resultado}`);
        }

        console.log('\n  ✓ Restauración terminada.');
        console.log('    Revisa el panel admin para confirmar que los datos están como esperabas.\n');
        process.exit(0);

    } catch (e) {
        console.error('\n  ✗ Error:', e.message);
        if (/descifrar|clave/i.test(e.message)) {
            console.error('    ¿Está BACKUP_ENCRYPTION_KEY definida y es la misma con la que se creó el respaldo?');
        }
        process.exit(1);
    }
})();
