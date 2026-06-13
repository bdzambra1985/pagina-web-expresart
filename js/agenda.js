const CATS = {
    obra:     { label: 'Obra de teatro', color: '#c0282a', rgb: '192,40,42',   dot: 'dot-obra' },
    taller:   { label: 'Taller',         color: '#c9a227', rgb: '201,162,39',  dot: 'dot-taller' },
    audicion: { label: 'Audición',       color: '#2a8ab4', rgb: '42,138,180',  dot: 'dot-audicion' },
    otro:     { label: 'Evento',         color: '#888888', rgb: '136,136,136', dot: 'dot-otro' }
};

const MONTHS_ES    = ['enero','febrero','marzo','abril','mayo','junio',
                      'julio','agosto','septiembre','octubre','noviembre','diciembre'];
const SHORT_MONTHS = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];

let allEvents    = [];
let currentYear  = new Date().getFullYear();
let currentMonth = new Date().getMonth();
let selectedDate = null;
let activeFilter = 'all';
let isLoggedIn   = false;

const today = new Date();
today.setHours(0,0,0,0);

initNavAuth();

async function loadEvents() {
    const tok = localStorage.getItem('exp_token') || '';
    try {
        const [evRes, authRes] = await Promise.all([
            fetch('/api/events'),
            fetch('/api/auth', { headers: { 'x-session-token': tok } })
        ]);
        allEvents  = await evRes.json();
        const auth = await authRes.json();
        isLoggedIn = auth.ok;
        if (!isLoggedIn) {
            allEvents = allEvents.filter(ev => (ev.audience || 'publico') !== 'alumnos');
        }
    } catch (e) {
        allEvents  = [];
        isLoggedIn = false;
    }
    renderLoginBanner();
    renderCalendar();
    renderUpcoming();
}

function renderLoginBanner() {
    const existing = document.getElementById('loginBanner');
    if (isLoggedIn) {
        if (existing) existing.remove();
        return;
    }
    if (existing) return;
    const banner = document.createElement('div');
    banner.id        = 'loginBanner';
    banner.className = 'login-banner';
    banner.innerHTML = `
        <i class="bx bx-info-circle"></i>
        <p>Estás viendo la agenda pública. <a href="login.html">Inicia sesión</a> para ver todos los detalles de cada evento: horarios, descripciones y más.</p>`;
    document.querySelector('.upcoming-section').prepend(banner);
}

function renderCalendar() {
    const title = document.getElementById('calMonthTitle');
    title.textContent = MONTHS_ES[currentMonth] + ' ' + currentYear;

    const grid = document.getElementById('calGrid');
    grid.innerHTML = '';

    const firstDay    = new Date(currentYear, currentMonth, 1).getDay();
    const offset      = (firstDay === 0) ? 6 : firstDay - 1;
    const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();

    const monthStr = String(currentMonth + 1).padStart(2, '0');
    const yearStr  = String(currentYear);
    const byDay    = {};
    allEvents.forEach(ev => {
        if (ev.date && ev.date.startsWith(yearStr + '-' + monthStr)) {
            byDay[ev.date] = byDay[ev.date] || [];
            byDay[ev.date].push(ev);
        }
    });

    for (let i = 0; i < offset; i++) {
        const empty = document.createElement('div');
        empty.className = 'cal-day empty';
        grid.appendChild(empty);
    }

    for (let d = 1; d <= daysInMonth; d++) {
        const dayStr  = yearStr + '-' + monthStr + '-' + String(d).padStart(2,'0');
        const dayDate = new Date(currentYear, currentMonth, d);
        const isToday    = dayDate.getTime() === today.getTime();
        const isSelected = selectedDate === dayStr;
        const events     = byDay[dayStr] || [];

        const cell = document.createElement('div');
        cell.className = 'cal-day'
            + (isToday    ? ' today'      : '')
            + (isSelected ? ' selected'   : '')
            + (events.length ? ' has-events' : '');
        cell.dataset.date = dayStr;

        const numEl = document.createElement('div');
        numEl.className = 'day-num';
        numEl.textContent = d;
        cell.appendChild(numEl);

        if (events.length) {
            const dots = document.createElement('div');
            dots.className = 'day-dots';
            const shown = {};
            events.slice(0,3).forEach(ev => {
                const cat = ev.category || 'otro';
                if (!shown[cat]) {
                    shown[cat] = true;
                    const dot = document.createElement('span');
                    dot.className = 'dot ' + (CATS[cat] ? CATS[cat].dot : 'dot-otro');
                    dots.appendChild(dot);
                }
            });
            cell.appendChild(dots);
        }

        cell.onclick = () => selectDay(dayStr, events);
        grid.appendChild(cell);
    }
}

function selectDay(dateStr, events) {
    selectedDate = dateStr;
    renderCalendar();

    const [y, m, d] = dateStr.split('-');
    const label = parseInt(d) + ' de ' + MONTHS_ES[parseInt(m) - 1] + ' de ' + y;
    document.getElementById('panelDateTitle').textContent = label;

    const content = document.getElementById('panelContent');
    if (!events.length) {
        content.innerHTML = '<p class="panel-empty">No hay eventos este día</p>';
        return;
    }
    content.innerHTML = events.map(ev => eventCardHTML(ev)).join('');
}

function renderUpcoming() {
    const list     = document.getElementById('upcomingList');
    const todayStr = today.toISOString().slice(0,10);

    let filtered = allEvents.filter(ev => ev.date >= todayStr);
    if (activeFilter !== 'all') filtered = filtered.filter(ev => ev.category === activeFilter);
    filtered.sort((a,b) => a.date.localeCompare(b.date));

    if (!filtered.length) {
        list.innerHTML = '<div class="no-upcoming"><i class="bx bx-calendar-x"></i>No hay eventos próximos' + (activeFilter !== 'all' ? ' en esta categoría' : '') + '</div>';
        return;
    }

    list.innerHTML = filtered.map(ev => {
        const cat  = CATS[ev.category] || CATS.otro;
        const [y, m, d] = ev.date.split('-');
        const detailRows = isLoggedIn
            ? `<div class="uc-meta">
                    ${ev.time     ? `<span><i class="bx bx-time"></i>${esc(ev.time)}</span>` : ''}
                    ${ev.location ? `<span><i class="bx bx-map"></i>${esc(ev.location)}</span>` : ''}
               </div>
               ${ev.description ? `<div class="uc-desc">${esc(ev.description)}</div>` : ''}`
            : `<div class="uc-meta">
                    ${ev.location ? `<span><i class="bx bx-map"></i>${esc(ev.location)}</span>` : ''}
               </div>
               <div class="uc-login-hint"><i class="bx bx-lock-alt"></i><a href="login.html" style="color:inherit">Inicia sesión</a> para ver horario y detalles</div>`;
        return `
        <div class="upcoming-card" style="--cat-color:${cat.color}; --cat-rgb:${cat.rgb}"
             data-goto="${esc(ev.date)}">
            <div class="uc-date-box">
                <div class="uc-day">${parseInt(d)}</div>
                <div class="uc-month">${SHORT_MONTHS[parseInt(m)-1]}</div>
            </div>
            <div class="uc-body">
                <div class="uc-cat">${cat.label}</div>
                <div class="uc-title">${esc(ev.title)}</div>
                ${detailRows}
            </div>
        </div>`;
    }).join('');
}

function goToDate(dateStr) {
    const [y, m] = dateStr.split('-');
    currentYear  = parseInt(y);
    currentMonth = parseInt(m) - 1;
    const dayStr = dateStr;
    const events = allEvents.filter(ev => ev.date === dayStr);
    renderCalendar();
    selectDay(dayStr, events);
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function eventCardHTML(ev) {
    const cat = CATS[ev.category] || CATS.otro;
    if (isLoggedIn) {
        return `
        <div class="event-card" style="--cat-color:${cat.color}">
            <span class="event-cat-badge">${cat.label}</span>
            <div class="event-title">${esc(ev.title)}</div>
            <div class="event-meta">
                ${ev.time     ? `<span><i class="bx bx-time"></i>${esc(ev.time)}</span>` : ''}
                ${ev.location ? `<span><i class="bx bx-map"></i>${esc(ev.location)}</span>` : ''}
            </div>
            ${ev.description ? `<div class="event-desc">${esc(ev.description)}</div>` : ''}
        </div>`;
    }
    return `
    <div class="event-card" style="--cat-color:${cat.color}">
        <span class="event-cat-badge">${cat.label}</span>
        <div class="event-title">${esc(ev.title)}</div>
        <div class="event-meta">
            ${ev.location ? `<span><i class="bx bx-map"></i>${esc(ev.location)}</span>` : ''}
        </div>
        <div class="event-login-hint"><i class="bx bx-lock-alt"></i><a href="login.html" style="color:inherit">Inicia sesión</a> para ver hora y descripción</div>
    </div>`;
}

document.getElementById('prevMonth').onclick = () => {
    currentMonth--;
    if (currentMonth < 0) { currentMonth = 11; currentYear--; }
    selectedDate = null;
    renderCalendar();
    document.getElementById('panelDateTitle').textContent = 'Selecciona un día';
    document.getElementById('panelContent').innerHTML = '<p class="panel-empty">Haz clic en un día del calendario para ver los eventos</p>';
};
document.getElementById('nextMonth').onclick = () => {
    currentMonth++;
    if (currentMonth > 11) { currentMonth = 0; currentYear++; }
    selectedDate = null;
    renderCalendar();
    document.getElementById('panelDateTitle').textContent = 'Selecciona un día';
    document.getElementById('panelContent').innerHTML = '<p class="panel-empty">Haz clic en un día del calendario para ver los eventos</p>';
};

document.getElementById('catFilters').querySelectorAll('.cat-filter').forEach(btn => {
    btn.onclick = () => {
        document.querySelectorAll('.cat-filter').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeFilter = btn.dataset.cat;
        renderUpcoming();
    };
});

document.addEventListener('click', function(e) {
    const card = e.target.closest('.upcoming-card[data-goto]');
    if (card) goToDate(card.dataset.goto);
});

loadEvents();
