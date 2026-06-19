initNavAuth();

// Calcula años desde el 4 de marzo de 2023 — se incrementa cada 4 de marzo
(function updateAnios() {
    const now     = new Date();
    const founded = new Date(2023, 2, 4); // 4 mar 2023
    let years = now.getFullYear() - founded.getFullYear();
    if (now < new Date(now.getFullYear(), 2, 4)) years--;
    const el = document.getElementById('nosAniosCount');
    if (el) el.textContent = years;
})();

const DEFAULTS = {
    historia: {
        texto1:    'EXPRESART nació con el propósito de abrir un espacio donde la expresión artística y el teatro sean accesibles para todos. Fundada por artistas y docentes apasionados por las artes escénicas, nuestra escuela se ha convertido en un semillero de talentos que transforman el escenario en un lugar de vida, emoción y comunicación.',
        texto2:    'Desde nuestros inicios hemos formado actores, artistas y comunicadores capaces de conectar con el público desde la autenticidad y la técnica.',
        cita:      'El teatro es el arte de hacer vivir lo que no existe, y existir lo que no se ve.',
        citaAutor: 'EXPRESART'
    },
    mision: {
        misionTexto: 'Formar artistas escénicos con bases técnicas sólidas, sensibilidad creativa y vocación de comunicar, brindando una educación teatral de calidad en un ambiente de respeto, pasión y disciplina.',
        visionTexto: 'Ser la escuela de actuación de referencia de la región, reconocida por la excelencia de sus egresados y por su compromiso con el arte escénico como herramienta de transformación personal y social.',
        cita:        'Formamos artistas que no solo actúan — transforman el mundo desde el escenario.',
        citaAutor:   'Dirección EXPRESART'
    },
    valores: [
        { icono: '🔥', nombre: 'Pasión',     descripcion: 'Enseñamos desde el amor genuino por el arte escénico.' },
        { icono: '🎯', nombre: 'Disciplina', descripcion: 'El talento se potencia con trabajo constante y dedicación.' },
        { icono: '🤝', nombre: 'Comunidad',  descripcion: 'El teatro es colectivo — juntos crecemos — juntos brillamos.' }
    ],
    niveles: [
        { titulo: 'Actuación Básica',            descripcion: 'Introducción a las técnicas fundamentales de la actuación: expresión corporal, voz, respiración y presencia escénica.',          etiqueta: 'Nivel 1 — Principiantes', duracion: '' },
        { titulo: 'Actuación Intermedia',        descripcion: 'Desarrollo de habilidades expresivas, construcción de personaje, improvisación y trabajo en escenas cortas con otros actores.', etiqueta: 'Nivel 2 — Intermedio',    duracion: '' },
        { titulo: 'Actuación Avanzada',          descripcion: 'Profundización en métodos de interpretación, trabajo con texto dramático y producción de obra completa ante el público.',       etiqueta: 'Nivel 3 — Avanzado',      duracion: '' },
        { titulo: 'Taller de Puesta en Escena', descripcion: 'Producción de una obra completa: desde la lectura del guion hasta la presentación ante el público.',                             etiqueta: 'Todos los niveles',       duracion: '' }
    ]
};

async function loadNosotros() {
    let nos = null;
    try {
        const r = await fetch('/api/content');
        const c = await r.json();
        nos = c.nosotros || null;
    } catch { /* usa defaults */ }

    // Los textos (historia, misión, visión, citas) viven en el HTML y no se
    // sobreescriben desde la DB para evitar que versiones antiguas piseen el contenido correcto.
    // Los grids de valores y niveles sí requieren JS porque sus contenedores están vacíos en el HTML.

    const v = (nos && nos.valores && nos.valores.length) ? nos.valores : DEFAULTS.valores;
    const n = (nos && nos.niveles && nos.niveles.length) ? nos.niveles : DEFAULTS.niveles;

    document.getElementById('nosValoresGrid').innerHTML = v.map(vl => `
        <div class="valor-card">
            <span class="valor-icon">${esc(vl.icono)}</span>
            <p class="valor-name">${esc(vl.nombre)}</p>
            <p class="valor-desc">${esc(vl.descripcion)}</p>
        </div>`).join('');

    document.getElementById('nosCursosGrid').innerHTML = n.map(nv => `
        <div class="curso-card">
            <h3 class="curso-titulo">${esc(nv.titulo)}</h3>
            <p class="curso-desc">${esc(nv.descripcion)}</p>
            ${nv.duracion ? `<span class="curso-tag" style="margin-right:6px"><i class="bx bx-time-five" style="vertical-align:middle;margin-right:3px"></i>${esc(nv.duracion)}</span>` : ''}
            <span class="curso-tag">${esc(nv.etiqueta)}</span>
        </div>`).join('');
}

loadNosotros();
