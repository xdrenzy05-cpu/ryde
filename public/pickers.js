/* Custom pickers: replaces the phone's built-in dropdown and date popups with RydeHaul-styled ones.
   The original <select> / <input type="date"> stay in the page (hidden), so forms, values and the
   price quote keep working exactly as before. */
(() => {
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const pad = n => String(n).padStart(2, '0');
  const iso = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
  const parse = s => { const [y, m, d] = s.split('-').map(Number); return { y, m: m - 1, d }; };
  const fmt = s => { if (!s) return 'Choose a date'; const { y, m, d } = parse(s); return `${MONTHS[m].slice(0, 3)} ${d}, ${y}`; };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fire = el => el.dispatchEvent(new Event('input', { bubbles: true }));
  const labelOf = el => (document.querySelector(`label[for="${el.id}"]`) || {}).textContent || '';
  let open = null;

  /* ---------- bottom sheet ---------- */
  function sheet(title, bodyHtml, host, opener) {
    closeSheet(true);
    const s = document.createElement('div');
    s.className = 'sheet';
    s.innerHTML = `<div class="sheet-bg" data-close></div><div class="sheet-panel" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="sheet-grip"></div><div class="sheet-head"><h2>${esc(title)}</h2><button type="button" class="link" data-close>Close</button></div>
      <div class="sheet-body">${bodyHtml}</div></div>`;
    s.addEventListener('click', e => { if (e.target.closest('[data-close]')) closeSheet(); });
    (host || document.body).appendChild(s);
    open = { s, opener };
    return s;
  }
  function closeSheet(quiet) {
    if (!open) return;
    const { s, opener } = open; open = null; s.remove();
    if (!quiet && opener && opener.isConnected) opener.focus();
  }
  document.addEventListener('keydown', e => {
    if (open && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSheet(); }
  }, true);

  /* ---------- dropdown ---------- */
  function enhanceSelect(sel) {
    sel.dataset.pk = '1'; sel.classList.add('pk-native'); sel.tabIndex = -1;
    const opts = [...sel.options];
    const title = labelOf(sel).trim() || 'Choose one';

    if (opts.length <= 3) {                       // few choices: show them as buttons right on the form
      const seg = document.createElement('div');
      seg.className = 'seg'; seg.setAttribute('role', 'radiogroup'); seg.setAttribute('aria-label', title);
      seg.innerHTML = opts.map(o => `<button type="button" role="radio" data-v="${esc(o.value)}">${esc(o.textContent)}</button>`).join('');
      const sync = () => seg.querySelectorAll('button').forEach(b => {
        const on = b.dataset.v === sel.value; b.classList.toggle('on', on); b.setAttribute('aria-checked', on);
      });
      seg.addEventListener('click', e => {
        const b = e.target.closest('button'); if (!b) return;
        sel.value = b.dataset.v; sync(); fire(sel);
      });
      sel.after(seg); sel._pkSync = sync; sync();
      return;
    }

    const btn = document.createElement('button');   // many choices: one tap opens a sheet
    btn.type = 'button'; btn.className = 'picker'; btn.setAttribute('aria-haspopup', 'dialog');
    const sync = () => { btn.textContent = sel.options[sel.selectedIndex]?.textContent || 'Choose'; };
    btn.addEventListener('click', () => {
      const list = [...sel.options].map(o => `<button type="button" class="pk-opt${o.value === sel.value ? ' on' : ''}" role="option" aria-selected="${o.value === sel.value}" data-v="${esc(o.value)}"><span>${esc(o.textContent)}</span><i aria-hidden="true"></i></button>`).join('');
      const s = sheet(title, `<div class="pk-list" role="listbox">${list}</div>`, btn.closest('dialog'), btn);
      s.addEventListener('click', e => {
        const b = e.target.closest('.pk-opt'); if (!b) return;
        sel.value = b.dataset.v; sync(); closeSheet(); fire(sel);
      });
      (s.querySelector('.pk-opt.on') || s.querySelector('.pk-opt')).focus();
      const on = s.querySelector('.pk-opt.on'); if (on) on.scrollIntoView({ block: 'center' });
    });
    sel.after(btn); sel._pkSync = sync; sync();
  }

  /* ---------- calendar ---------- */
  function minFor(inp) {
    let m = inp.min || '';
    if (inp.id === 'end') { const st = document.getElementById('start'); if (st && st.value > m) m = st.value; }
    return m;
  }
  function enhanceDate(inp) {
    inp.dataset.pk = '1'; inp.classList.add('pk-native'); inp.tabIndex = -1;
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'picker date'; btn.setAttribute('aria-haspopup', 'dialog');
    const sync = () => { btn.textContent = fmt(inp.value); };
    btn.addEventListener('click', () => {
      const min = minFor(inp), now = new Date();
      const base = parse(inp.value || min || iso(now.getFullYear(), now.getMonth(), now.getDate()));
      let vy = base.y, vm = base.m;
      const todayIso = iso(now.getFullYear(), now.getMonth(), now.getDate());
      const s = sheet(labelOf(inp).trim() || 'Choose a date', '<div class="cal"></div>', btn.closest('dialog'), btn);
      const cal = s.querySelector('.cal');
      const draw = () => {
        const first = new Date(vy, vm, 1).getDay(), days = new Date(vy, vm + 1, 0).getDate();
        const minM = min ? parse(min) : null;
        const canPrev = !minM || vy > minM.y || (vy === minM.y && vm > minM.m);
        let cells = '';
        for (let i = 0; i < first; i++) cells += '<span></span>';
        for (let d = 1; d <= days; d++) {
          const v = iso(vy, vm, d), dis = min && v < min;
          cells += `<button type="button" class="day${v === inp.value ? ' on' : ''}${v === todayIso ? ' today' : ''}" data-v="${v}" ${dis ? 'disabled' : ''} ${v === inp.value ? 'aria-pressed="true"' : ''}>${d}</button>`;
        }
        cal.innerHTML = `<div class="cal-nav"><button type="button" class="cal-step" data-step="-1" aria-label="Previous month" ${canPrev ? '' : 'disabled'}>‹</button>
          <b>${MONTHS[vm]} ${vy}</b><button type="button" class="cal-step" data-step="1" aria-label="Next month">›</button></div>
          <div class="cal-grid cal-dow" aria-hidden="true">${'SMTWTFS'.split('').map(c => `<span>${c}</span>`).join('')}</div><div class="cal-grid">${cells}</div>`;
      };
      cal.addEventListener('click', e => {
        const st = e.target.closest('.cal-step');
        if (st) { vm += Number(st.dataset.step); if (vm < 0) { vm = 11; vy--; } if (vm > 11) { vm = 0; vy++; } draw(); return; }
        const d = e.target.closest('.day'); if (!d || d.disabled) return;
        inp.value = d.dataset.v; sync();
        if (inp.id === 'start') {                     // keep the return date from landing before the start date
          const end = document.getElementById('end');
          if (end && end.value < inp.value) { end.value = inp.value; end._pkSync && end._pkSync(); }
        }
        closeSheet(); fire(inp);
      });
      draw();
      (cal.querySelector('.day.on') || cal.querySelector('.day:not([disabled])') || cal.querySelector('.cal-step')).focus();
    });
    inp.after(btn); inp._pkSync = sync; sync();
  }

  /* ---------- watch the page for new forms ---------- */
  const scan = () => {
    document.querySelectorAll('select:not([data-pk])').forEach(enhanceSelect);
    document.querySelectorAll('input[type=date]:not([data-pk])').forEach(enhanceDate);
  };
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  scan();
})();
