function buildSeats() {
    const container = document.getElementById('seatsContainer');
    container.innerHTML = '';

    const isMobile = window.innerWidth < 520;
    const backRows  = 6;
    const frontRows = 2;

    const wrapper  = container.closest('.seats-perspective') || container.parentElement;
    const availW   = wrapper.offsetWidth * 0.97;

    const seatW  = isMobile
        ? Math.max(9,  Math.min(16, availW * 0.020))
        : Math.max(5,  Math.min(10, availW * 0.0075));
    const seatH  = Math.round(seatW * 1.5);
    const gap    = Math.max(2, Math.floor(seatW * 0.20));
    const aisleW = Math.max(18, Math.round(availW * 0.055));

    container.style.setProperty('--sw', seatW  + 'px');
    container.style.setProperty('--sh', seatH  + 'px');
    container.style.setProperty('--sg', gap    + 'px');

    const sideW     = (availW - aisleW) / 2;
    const baseSeats = Math.max(4, Math.floor(sideW / (seatW + gap)));

    function makeRow(r) {
        const row = document.createElement('div');
        row.className = 'seat-row';
        const seatsPerSide = baseSeats + r;
        const leftGroup  = document.createElement('div');
        leftGroup.className = 'seat-group';
        const aisle = document.createElement('div');
        aisle.className = 'row-aisle';
        aisle.style.width = aisleW + 'px';
        const rightGroup = document.createElement('div');
        rightGroup.className = 'seat-group';
        for (let s = 0; s < seatsPerSide; s++) {
            const sL = document.createElement('div'); sL.className = 'seat'; leftGroup.appendChild(sL);
            const sR = document.createElement('div'); sR.className = 'seat'; rightGroup.appendChild(sR);
        }
        row.appendChild(leftGroup);
        row.appendChild(aisle);
        row.appendChild(rightGroup);
        return row;
    }

    for (let r = 0; r < backRows; r++) {
        container.appendChild(makeRow(r));
    }

    const separator = document.createElement('div');
    separator.style.cssText = 'width:100%;height:' + Math.round(seatH * 1.2) + 'px;flex-shrink:0;';
    container.appendChild(separator);

    for (let r = 0; r < frontRows; r++) {
        container.appendChild(makeRow(backRows + r));
    }
}

buildSeats();

let _rt;
window.addEventListener('resize', function () {
    clearTimeout(_rt);
    _rt = setTimeout(buildSeats, 200);
});

initNavAuth();
