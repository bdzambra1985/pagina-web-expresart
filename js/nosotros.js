initNavAuth();

const DEFAULTS = {
    historia: {
        texto1: 'EXPRESART nació con el propósito de abrir un espacio donde la expresión artística y el teatro sean accesibles para todos. Fundada por artistas y docentes apasionados por las artes escénicas, nuestra escuela se ha convertido en un semillero de talentos que transforman el escenario en un lugar de vida, emoción y comunicación.',
        texto2: 'Desde nuestros inicios hemos formado actores, artistas y comunicadores capaces de conectar con el público desde la autenticidad y la técnica.',
        cita: 'El teatro es el arte de hacer vivir lo que no existe, y existir lo que no se ve.',
        citaAutor: 'EXPRESART'
    },
    mision: {
        misionTexto: 'Formar artistas escénicos con bases técnicas sólidas, sensibilidad creativa y vocación de comunicar, brindando una educación teatral de calidad en un ambiente de respeto, pasión y disciplina.',
        visionTexto: 'Ser la escuela de actuación de referencia de la región, reconocida por la excelencia de sus egresados y por su compromiso con el arte escénico como herramienta de transformación personal y social.',
        cita: 'Formamos artistas que no solo actúan — transforman el mundo desde el escenario.',
        citaAutor: 'Dirección EXPRESART'
    },
    valores: [
        { icono: '🔥', nombre: 'Pasión',     descripcion: 'Enseñamos desde el amor genuino por el arte escénico.' },
        { icono: '🎯', nombre: 'Disciplina', descripcion: 'El talento se potencia con trabajo constante y dedicación.' },
        { icono: '🤝', nombre: 'Comunidad',  descripcion: 'El teatro es colectivo — juntos crecemos — juntos brillamos.' }
    ],
    niveles: [
        { titulo: 'Nivel Básico',               descripcion: 'Introducción a las técnicas fundamentales de la actuación: expresión corporal, voz, respiración y presencia escénica.',                                                          etiqueta: 'Nivel 1 — Principiantes', duracion: '' },
        { titulo: 'Nivel Intermedio',            descripcion: 'Desarrollo de habilidades expresivas, construcción de personaje, improvisación y trabajo en escenas cortas con otros actores.',                                                  etiqueta: 'Nivel 2 — Intermedio',   duracion: '' },
        { titulo: 'Nivel Avanzado',              descripcion: 'Profundización en métodos de interpretación, trabajo con texto dramático y producción de obra completa ante el público.',                                                        etiqueta: 'Nivel 3 — Avanzado',     duracion: '' },
        { titulo: 'Taller de Puesta en Escena', descripcion: 'Producción de una obra completa: desde la lectura del guion hasta la presentación ante el público.',                                                                             etiqueta: 'Todos los niveles',      duracion: '' }
    ]
};

async function loadNosotros() {
    let nos = null;
    try {
        const r = await fetch('/api/content');
        const c = await r.json();
        nos = c.nosotros || null;
    } catch { /* conserva el contenido HTML por defecto */ }

    // Solo sobreescribe si el admin ya guardó contenido
    if (!nos) return;

    const h = nos.historia || {};
    const m = nos.mision   || {};

    if (h.texto1)    document.getElementById('nos_h_texto1').textContent    = h.texto1;
    if (h.texto2)    document.getElementById('nos_h_texto2').textContent    = h.texto2;
    if (h.cita)      document.getElementById('nos_h_cita').textContent      = '"' + h.cita + '"';
    if (h.citaAutor) document.getElementById('nos_h_citaAutor').textContent = '— ' + h.citaAutor;

    if (m.misionTexto) document.getElementById('nos_m_mision').textContent    = m.misionTexto;
    if (m.visionTexto) document.getElementById('nos_m_vision').textContent    = m.visionTexto;
    if (m.cita)        document.getElementById('nos_m_cita').textContent      = '"' + m.cita + '"';
    if (m.citaAutor)   document.getElementById('nos_m_citaAutor').textContent = '— ' + m.citaAutor;

    // Valores
    const vgrid = document.getElementById('nosValoresGrid');
    vgrid.innerHTML = v.map(vl => `
        <div class="valor-card">
            <span class="valor-icon">${esc(vl.icono)}</span>
            <p class="valor-name">${esc(vl.nombre)}</p>
            <p class="valor-desc">${esc(vl.descripcion)}</p>
        </div>`).join('');

    // Niveles
    const ngrid = document.getElementById('nosCursosGrid');
    ngrid.innerHTML = n.map(nv => `
        <div class="curso-card">
            <h3 class="curso-titulo">${esc(nv.titulo)}</h3>
            <p class="curso-desc">${esc(nv.descripcion)}</p>
            ${nv.duracion ? `<span class="curso-tag" style="margin-right:6px"><i class="bx bx-time-five" style="vertical-align:middle;margin-right:3px"></i>${esc(nv.duracion)}</span>` : ''}
            <span class="curso-tag">${esc(nv.etiqueta)}</span>
        </div>`).join('');
}

loadNosotros();
