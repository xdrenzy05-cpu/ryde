/* RydeHaul web app: plain JavaScript, no framework.
   Screens are functions that return HTML; clicks use data-act="name" and forms use data-form="name". */
(() => {
'use strict';
const $ = s => document.querySelector(s);
const app = $('#app');
const S = { token: localStorage.getItem('rh_token'), user: null, tab: null, view: null, auth: 'login',
            q: '', type: 'All', timers: [], map: null, layer: null, fitted: false, watch: null, sim: null,
            vehicles: [], bookings: [], trackT: null };

// Preset places (Luzon, reachable by road). Real GPS coordinates.
const PLACES = { 'Manila': [14.5995, 120.9842], 'Quezon City': [14.676, 121.0437], 'Tagaytay': [14.1153, 120.9621],
  'Batangas City': [13.7565, 121.0583], 'Angeles': [15.1450, 120.5887], 'Baguio': [16.4023, 120.596], 'Vigan': [17.5747, 120.3869], 'Naga': [13.6218, 123.1948] };
const pl = n => ({ label: n, lat: PLACES[n][0], lng: PLACES[n][1] });

/* ---------- helpers ---------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const peso = n => '₱' + Number(n || 0).toLocaleString('en-PH');
const label = s => s ? s[0].toUpperCase() + s.slice(1) : '';
const fmtDate = d => new Date(d + 'T00:00:00').toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
const fmtTime = iso => new Date(iso).toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' });
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
const eta = m => m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
let tt;
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(tt); tt = setTimeout(() => t.classList.remove('show'), 3400); }

async function api(path, method = 'GET', body) {
  const r = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}) },
                                         body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { if (r.status === 401 && S.token) logout(); throw new Error(d.error || 'Something went wrong'); }
  return d;
}

function dialog(title, html, fn, submit = 'Save') {
  const d = $('#dlg');
  d.innerHTML = `<form class="stack"><h2>${title}</h2>${html}<div class="row"><button type="button" class="btn btn2" data-act="closeDlg">Cancel</button><button class="btn">${submit}</button></div></form>`;
  d.querySelector('form').onsubmit = async e => {
    e.preventDefault();
    try { await fn(Object.fromEntries(new FormData(e.target))); d.close(); show(); } catch (err) { toast(err.message); }
  };
  d.showModal();
}
const field = (id, text, attrs = '', val = '') => `<div><label for="${id}">${text}</label><input id="${id}" name="${id}" value="${esc(val)}" ${attrs}></div>`;
const kv = (a, b, cls = '') => `<div class="kv ${cls}"><span>${a}</span><span>${b}</span></div>`;

/* ---------- auth ---------- */
function authScreen() {
  const reg = S.auth === 'register';
  app.innerHTML = `<div class="auth"><img class="auth-logo" src="logo.png" alt="RydeHaul: car rental, tracking, long term services">
  <p class="muted tagline">Rent a ride for hauling, moving, and long trips.</p>
  <div class="chips"><button class="chip ${reg ? '' : 'on'}" data-act="auth" data-mode="login">Log in</button><button class="chip ${reg ? 'on' : ''}" data-act="auth" data-mode="register">Create account</button></div>
  <form data-form="auth" class="stack" novalidate>
    ${reg ? field('name', 'Full name', 'autocomplete="name"') + field('phone', 'Mobile number', 'type="tel" autocomplete="tel"') +
      `<div class="opts" role="radiogroup" aria-label="I am a"><label class="opt"><input type="radio" name="role" value="renter" checked> Renter</label><label class="opt"><input type="radio" name="role" value="owner"> Car owner</label></div>` : ''}
    ${field('email', 'Email', 'type="email" autocomplete="email"')}
    ${field('password', 'Password', `type="password" autocomplete="${reg ? 'new-password' : 'current-password'}"`)}
    <button class="btn block">${reg ? 'Create account' : 'Log in'}</button>
  </form>
  <p class="muted">Demo accounts: renter@rydehaul.ph / renter123, owner@rydehaul.ph / owner123, admin@rydehaul.ph / admin123</p></div>`;
}
function logout() {
  localStorage.removeItem('rh_token'); S.token = null; S.user = null; S.view = null; clearTimers(); authScreen();
}
function go() { S.tab = TABS[S.user.role][0][0]; S.view = null; show(); }

/* ---------- shell and navigation ---------- */
const TABS = {
  renter: [['browse', 'Browse'], ['bookings', 'Bookings'], ['profile', 'Profile']],
  owner: [['fleet', 'Fleet'], ['requests', 'Requests'], ['live', 'Live map'], ['reports', 'Reports']],
  admin: [['verify', 'Verify'], ['users', 'Users'], ['summary', 'Summary']]
};
function shell(content) {
  return `<header class="top"><img class="brand-mark" src="logo-mark.png" alt="RydeHaul">
  <div class="who"><span>${esc(S.user.name)}</span><button class="link" data-act="logout">Log out</button></div></header>
  <nav class="tabs" aria-label="Main">${TABS[S.user.role].map(t => `<button class="${S.tab === t[0] && !S.view ? 'on' : ''}" data-act="tab" data-tab="${t[0]}">${t[1]}</button>`).join('')}</nav>
  <main id="main">${content}</main>`;
}
function clearTimers() {
  S.timers.forEach(clearInterval); S.timers = []; stopTracking();
  if (S.map) { S.map.remove(); S.map = null; }
  S.layer = null; S.fitted = false;
}
async function show() {
  clearTimers();
  app.innerHTML = shell('<p class="muted pad">Loading…</p>');
  try {
    const s = await SCREENS[S.view ? S.view.name : S.tab]();
    $('#main').innerHTML = s.html; if (s.after) s.after();
  } catch (e) {
    $('#main').innerHTML = `<div class="card stack"><h2>This page could not load</h2><p class="muted">${esc(e.message)}</p><button class="btn" data-act="reload">Try again</button></div>`;
  }
  window.scrollTo(0, 0);
}

/* ---------- maps (Leaflet + OpenStreetMap) ---------- */
function mkMap(el) {
  if (!window.L) { el.innerHTML = '<p class="muted pad">The map needs an internet connection. Trip details are shown below.</p>'; return null; }
  const m = L.map(el).setView([14.6, 121], 8);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap' }).addTo(m);
  S.map = m; return m;
}
const dot = c => L.divIcon({ className: '', html: `<span class="dot ${c}"></span>`, iconSize: [22, 22], iconAnchor: [11, 11] });
function drawTrack(t) {
  if (!S.map) return;
  if (S.layer) S.layer.remove();
  const g = S.layer = L.layerGroup().addTo(S.map), b = t.booking, P = [b.pickup.lat, b.pickup.lng], D = [b.dropoff.lat, b.dropoff.lng];
  L.polyline([P, D], { color: '#121413', weight: 4, dashArray: '6 10', opacity: .75 }).addTo(g);
  L.marker(P, { icon: dot('pick') }).bindTooltip('Pick-up: ' + b.pickup.label).addTo(g);
  L.marker(D, { icon: dot('drop') }).bindTooltip('Drop-off: ' + b.dropoff.label).addTo(g);
  if (t.trail.length > 1) L.polyline(t.trail.map(p => [p.lat, p.lng]), { color: '#FB9A0B', weight: 6 }).addTo(g);
  if (t.last) L.marker([t.last.lat, t.last.lng], { icon: dot('car') }).bindTooltip(t.vehicle.name).addTo(g);
  if (!S.fitted) { S.map.fitBounds(L.latLngBounds([P, D]).pad(.3)); S.fitted = true; }
}
function drawLive(items) {
  if (!S.map) return;
  if (S.layer) S.layer.remove();
  const g = S.layer = L.layerGroup().addTo(S.map), pts = [];
  items.forEach(t => {
    const b = t.booking, P = [b.pickup.lat, b.pickup.lng], D = [b.dropoff.lat, b.dropoff.lng]; pts.push(P, D);
    L.polyline([P, D], { color: '#121413', weight: 3, dashArray: '6 10', opacity: .7 }).addTo(g);
    if (t.last) { pts.push([t.last.lat, t.last.lng]); L.marker([t.last.lat, t.last.lng], { icon: dot('car') }).bindTooltip(`${t.name} (${t.vehicle.plate})`).addTo(g); }
  });
  if (!S.fitted && pts.length) { S.map.fitBounds(L.latLngBounds(pts).pad(.3)); S.fitted = true; }
}

/* ---------- GPS sharing and the demo simulator ---------- */
function stopTracking() {
  if (S.sim) { clearInterval(S.sim); S.sim = null; }
  if (S.watch != null && navigator.geolocation) { navigator.geolocation.clearWatch(S.watch); S.watch = null; }
}
async function sendLocation(id, lat, lng) {
  const r = await api('/location', 'POST', { bookingId: id, lat, lng });
  if (r.outside) toast(`Off route by ${r.offRouteKm} km. The owner was alerted.`);
  tick();
}
async function tick() {
  if (!S.view || S.view.name !== 'track') return;
  const t = await api('/track/' + S.view.id).catch(() => null);
  if (!t || !$('#tinfo')) return;
  S.trackT = t; $('#tinfo').innerHTML = trackInfo(t); drawTrack(t);
}
function trackInfo(t) {
  const alerts = t.alerts.map(a => `<p class="chip s-pending">${fmtTime(a.at)} · Off route</p>`).join('');
  return `<div class="row"><h3>${esc(t.vehicle.name)}</h3>${t.booking.status === 'active' ? '' : `<span class="chip s-${t.booking.status}">${label(t.booking.status)}</span>`}</div>
  ${kv('Distance left', t.remainingKm + ' km')}${kv('Estimated arrival', eta(t.etaMin))}${kv('Last GPS update', t.last ? fmtTime(t.last.at) : 'Waiting for GPS')}${alerts}`;
}

/* ---------- renter screens ---------- */
const vcard = v => `<article class="card vcard"><div class="tile">${esc(v.type)}</div>
  <div class="grow"><h3>${esc(v.name)}</h3><p class="muted">${v.seats} seats · ${esc(v.plate)} · ${v.ownerRating ? '★ ' + v.ownerRating : 'New owner'}</p>
  <div class="chips"><span class="chip s-${v.status}">${label(v.status)}</span><span class="chip">GPS tracked</span></div></div>
  <div class="price"><b>${peso(v.ratePerDay)}</b><small>per day</small><small>+ ${peso(v.ratePerKm)}/km</small>
  ${v.status === 'maintenance' ? '' : `<button class="btn sm" data-act="book" data-id="${v.id}">Book</button>`}</div></article>`;
function vlist() {
  const q = S.q.toLowerCase();
  const l = S.vehicles.filter(v => (S.type === 'All' || v.type === S.type) && (v.name + v.plate + v.type).toLowerCase().includes(q));
  return l.length ? l.map(vcard).join('') : '<div class="card"><p class="muted">No vehicles match your search. Clear the search or choose All.</p></div>';
}
const typeChips = () => ['All', ...new Set(S.vehicles.map(v => v.type))].map(t => `<button class="chip ${S.type === t ? 'on' : ''}" data-act="type" data-type="${esc(t)}">${esc(t)}</button>`).join('');

const SCREENS = {
  async browse() {
    const [vs, me] = await Promise.all([api('/vehicles'), api('/me')]); S.vehicles = vs; S.user = me;
    const lic = me.licenseStatus;
    const msg = { pending: 'An admin is checking your ID. You can browse while you wait.', rejected: 'Your last photo was rejected. Upload a clearer photo of your ID.', none: 'We verify every renter to protect vehicle owners.' }[lic];
    const banner = lic === 'verified' ? '' : `<div class="card note stack"><b>${lic === 'pending' ? 'Your ID is being checked' : 'Upload a valid ID to book'}</b><p class="muted">${msg}</p>${lic === 'pending' ? '' : '<button class="btn sm" data-act="tab" data-tab="profile">Upload ID</button>'}</div>`;
    return { html: `<h1>Find your ride</h1><input type="search" aria-label="Search vehicles" placeholder="Search vans, trucks, cars" value="${esc(S.q)}" data-oninput="search">
      <div class="chips" id="types">${typeChips()}</div>${banner}<div class="grid" id="vlist">${vlist()}</div>` };
  },

  async book() {
    const v = S.view.vehicle, opts = Object.keys(PLACES).map(p => `<option>${p}</option>`).join('');
    return { html: `<button class="link back" data-act="back">‹ Back</button><h1>Book ${esc(v.name)}</h1>
      <p class="muted">${esc(v.plate)} · ${v.seats} seats · ${peso(v.ratePerDay)}/day + ${peso(v.ratePerKm)}/km</p>
      <form data-form="book" data-oninput="quote" class="stack">
        <div><label for="service">Service</label><select id="service" name="service"><option>Moving</option><option>Hauling</option><option>Travel</option></select></div>
        <div class="two"><div><label for="pickup">Pick-up</label><select id="pickup" name="pickup">${opts}</select></div><div><label for="dropoff">Drop-off</label><select id="dropoff" name="dropoff">${opts}</select></div></div>
        <div class="two"><div><label for="start">Start date</label><input id="start" name="start" type="date" min="${today()}" value="${today()}"></div><div><label for="end">Return date</label><input id="end" name="end" type="date" min="${today()}" value="${today()}"></div></div>
        <div class="card" id="quote"></div>
        <div class="contract"><b>Rental contract</b><br>I will use the vehicle only for the stated trip, return it on time and in the same condition, allow live GPS tracking while the rental is active, and pay for any damage up to the security deposit.</div>
        ${field('signedName', 'Type your full name to sign', 'autocomplete="name"')}
        <label class="opt"><input type="checkbox" name="agree"> I agree to the rental contract</label>
        <div><span class="lbl">Payment method (demo only, nothing is charged)</span><div class="opts" role="radiogroup">
          ${[['gcash', 'GCash'], ['maya', 'Maya'], ['card', 'Card'], ['cash', 'Cash on pick-up']].map((m, i) => `<label class="opt"><input type="radio" name="method" value="${m[0]}" ${i ? '' : 'checked'}> ${m[1]}</label>`).join('')}</div></div>
        <button class="btn block">Confirm booking</button></form>`,
      after: () => { $('#dropoff').value = 'Baguio'; quote(); } };
  },

  async bookings() {
    S.bookings = await api('/bookings');
    return { html: `<h1>My bookings</h1>${S.bookings.length ? S.bookings.map(b => bcard(b, 'renter')).join('') : '<div class="card"><p class="muted">No bookings yet. Browse vehicles to make your first booking.</p></div>'}` };
  },

  async profile() {
    const me = S.user = await api('/me'), st = me.licenseStatus;
    const txt = { none: 'Not uploaded', pending: 'Waiting for admin check', verified: 'Verified', rejected: 'Rejected, upload a clearer photo' }[st];
    return { html: `<h1>Profile</h1><div class="card stack"><h3>${esc(me.name)}</h3><p class="muted">${esc(me.email)} · ${esc(me.phone || 'No phone added')}</p></div>
      <div class="card stack"><div class="row"><h3>Valid ID</h3><span class="chip s-${st === 'none' ? 'none' : st}">${txt}</span></div>
      <p class="muted">Upload a clear photo of the front of your driver’s license or any valid government-issued ID. Owners can only rent to verified renters.</p>
      <form data-form="license" class="stack"><input type="file" name="file" accept="image/*" aria-label="ID photo" required><button class="btn">Upload for verification</button></form></div>` };
  },

  async track() {
    const t = S.trackT = await api('/track/' + S.view.id);
    return { html: `<button class="link back" data-act="back">‹ Back</button><h1>Live trip</h1>
      <div class="map" id="map" role="region" aria-label="Trip map"></div><div class="card stack" id="tinfo">${trackInfo(t)}</div>
      <div class="card stack"><h3>Share your location</h3><p class="muted">Your phone sends its GPS position while the rental is active. To demo without driving, use the simulator.</p>
      <div class="chips"><button class="btn sm" data-act="share">Share my live location</button><button class="btn btn2 sm" data-act="sim" data-detour="0">Simulate trip</button>
      <button class="btn danger sm" data-act="sim" data-detour="1">Simulate detour</button><button class="btn btn2 sm" data-act="stop">Stop</button></div></div>`,
      after: () => { mkMap($('#map')); drawTrack(t); S.timers.push(setInterval(tick, 5000)); } };
  },

  /* ---------- owner screens ---------- */
  async fleet() {
    const [vs, ms] = await Promise.all([api('/vehicles'), api('/maintenance')]); S.vehicles = vs;
    const card = v => `<article class="card stack"><div class="row"><div><h3>${esc(v.name)}</h3><p class="muted">${esc(v.type)} · ${esc(v.plate)} · ${v.seats} seats</p></div><span class="chip s-${v.status}">${label(v.status)}</span></div>
      ${kv('Mileage', v.mileage.toLocaleString() + ' km')}${kv('Rate', peso(v.ratePerDay) + '/day + ' + peso(v.ratePerKm) + '/km')}${kv('Safe zone', v.geofenceKm + ' km from route')}
      <p><span class="chip ${v.serviceDue ? 's-pending' : ''}">${v.serviceDue ? 'Service due now' : v.kmToService + ' km until service'}</span></p>
      <div class="chips"><button class="btn btn2 sm" data-act="editVehicle" data-id="${v.id}">Edit</button><button class="btn btn2 sm" data-act="service" data-id="${v.id}">Log service</button>
      ${v.status === 'rented' ? '' : `<button class="btn ${v.status === 'maintenance' ? '' : 'danger'} sm" data-act="vstatus" data-id="${v.id}" data-to="${v.status === 'maintenance' ? 'available' : 'maintenance'}">${v.status === 'maintenance' ? 'Mark available' : 'Mark under maintenance'}</button>`}</div></article>`;
    const stats = ['available', 'rented', 'maintenance'].map(s => `<div class="card stat"><span class="muted">${label(s === 'maintenance' ? 'under maintenance' : s)}</span><b>${vs.filter(v => v.status === s).length}</b></div>`).join('');
    return { html: `<div class="row"><h1>Fleet</h1><button class="btn" data-act="addVehicle">Add vehicle</button></div><div class="stats">${stats}</div>
      <div class="grid">${vs.map(card).join('') || '<div class="card"><p class="muted">No vehicles yet. Add your first vehicle.</p></div>'}</div>
      <div class="card stack"><h3>Maintenance log</h3>${ms.length ? `<div class="scroll"><table><tr><th>Date</th><th>Vehicle</th><th>Service</th><th>Cost</th></tr>${ms.map(m => `<tr><td>${new Date(m.at).toLocaleDateString('en-PH')}</td><td>${esc(m.vehicleName)}</td><td>${esc(m.note)} (${m.km.toLocaleString()} km)</td><td>${peso(m.cost)}</td></tr>`).join('')}</table></div>` : '<p class="muted">No service recorded yet.</p>'}</div>` };
  },

  async requests() {
    [S.bookings, S.vehicles] = await Promise.all([api('/bookings'), api('/vehicles')]);
    return { html: `<h1>Rental requests</h1>${S.bookings.length ? S.bookings.map(b => bcard(b, 'owner')).join('') : '<div class="card"><p class="muted">No requests yet. They appear here when renters book your vehicles.</p></div>'}` };
  },

  async live() {
    const [items, alerts] = await Promise.all([api('/live'), api('/alerts')]);
    return { html: `<h1>Live fleet map</h1><div class="map" id="map" role="region" aria-label="Fleet map"></div><div class="stack" id="liveinfo">${liveInfo(items, alerts)}</div>`,
      after: () => { mkMap($('#map')); drawLive(items); S.timers.push(setInterval(liveTick, 5000)); } };
  },

  async reports() {
    const r = await api('/report');
    return { html: `<h1>Reports</h1><div class="stats">${[['Revenue', peso(r.revenue)], ['Expenses', peso(r.spent)], ['Net income', peso(r.net)], ['Completed trips', r.trips]].map(s => `<div class="card stat"><span class="muted">${s[0]}</span><b>${s[1]}</b></div>`).join('')}</div>
      <div class="card stack"><h3>Rental history</h3>${r.history.length ? `<div class="scroll"><table><tr><th>Dates</th><th>Vehicle</th><th>Route</th><th>Earned</th></tr>${r.history.map(b => `<tr><td>${fmtDate(b.start)}</td><td>${esc(b.vehicleName)}</td><td>${esc(b.pickup.label)} → ${esc(b.dropoff.label)}</td><td>${peso(b.earned)}</td></tr>`).join('')}</table></div>` : '<p class="muted">Completed rentals appear here.</p>'}</div>
      <div class="card stack"><h3>Expense log</h3><form data-form="expense" class="two">${field('label', 'What was it for')}${field('amount', 'Amount (₱)', 'type="number" min="1" step="any"')}<button class="btn">Add expense</button></form>
      ${r.expenses.length ? `<div class="scroll"><table><tr><th>Date</th><th>Expense</th><th>Amount</th></tr>${r.expenses.map(e => `<tr><td>${new Date(e.at).toLocaleDateString('en-PH')}</td><td>${esc(e.label)}</td><td>${peso(e.amount)}</td></tr>`).join('')}</table></div>` : '<p class="muted">No expenses logged yet.</p>'}</div>` };
  },

  /* ---------- admin screens ---------- */
  async verify() {
    const us = (await api('/admin/users')).filter(u => u.licenseStatus === 'pending');
    return { html: `<h1>ID verification</h1>${us.length ? us.map(u => `<article class="card row"><div><h3>${esc(u.name)}</h3><p class="muted">${esc(u.email)}</p></div><button class="btn sm" data-act="viewLicense" data-id="${u.id}" data-name="${esc(u.name)}">Review ID</button></article>`).join('') : '<div class="card"><p class="muted">No IDs are waiting for review.</p></div>'}` };
  },
  async users() {
    const us = await api('/admin/users');
    return { html: `<h1>Users</h1><div class="card scroll"><table><tr><th>Name</th><th>Email</th><th>Role</th><th>ID</th></tr>${us.map(u => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${label(u.role)}</td><td>${u.licenseStatus === 'n/a' ? '-' : label(u.licenseStatus)}</td></tr>`).join('')}</table></div>` };
  },
  async summary() {
    const r = await api('/admin/report'), n = o => Object.values(o).reduce((a, b) => a + b, 0);
    const stats = [['Users', n(r.users)], ['Vehicles', r.vehicles], ['Bookings', n(r.bookings)], ['Platform revenue', peso(r.revenue)], ['IDs to review', r.pendingLicenses], ['Alerts raised', r.alerts]];
    return { html: `<h1>System summary</h1><div class="stats">${stats.map(s => `<div class="card stat"><span class="muted">${s[0]}</span><b>${s[1]}</b></div>`).join('')}</div>` };
  }
};

/* ---------- shared pieces ---------- */
const btn = (t, a, id, cls = '') => `<button class="btn sm ${cls}" data-act="bact" data-do="${a}" data-id="${id}">${t}</button>`;
function bcard(b, role) {
  const acts = [];
  if (role === 'renter') {
    if (['pending', 'approved'].includes(b.status)) acts.push(btn('Cancel booking', 'cancel', b.id, 'danger'));
    if (b.status === 'active') acts.push(`<button class="btn sm" data-act="track" data-id="${b.id}">Track trip</button>`);
  } else {
    if (b.status === 'pending') acts.push(btn('Approve', 'approve', b.id), btn('Reject', 'reject', b.id, 'danger'));
    if (b.status === 'approved') acts.push(btn('Start rental (hand over)', 'start', b.id));
    if (b.status === 'active') acts.push(`<button class="btn sm" data-act="returnForm" data-id="${b.id}">Return and inspect</button>`);
  }
  if (b.status === 'completed' && !b.myReview) acts.push(`<button class="btn btn2 sm" data-act="reviewForm" data-id="${b.id}">Leave a review</button>`);
  return `<article class="card stack"><div class="row"><div><h3>${esc(b.vehicleName)}</h3><p class="muted">${esc(b.pickup.label)} → ${esc(b.dropoff.label)} · ${b.distanceKm} km</p></div>${b.status === 'active' ? '' : `<span class="chip s-${b.status}">${label(b.status)}</span>`}</div>
  <p class="muted">${fmtDate(b.start)} to ${fmtDate(b.end)} · ${esc(b.service)}${role === 'owner' ? ` · Renter: ${esc(b.renterName)}${b.renterRating ? ' ★' + b.renterRating : ''}` : ''}</p>
  <div class="row"><b>${peso(b.total)}</b><span class="chip s-${b.payment.status === 'paid' ? 'paid' : 'pending'}">${esc(label(b.payment.method))}: ${esc(b.payment.status)}</span></div>
  ${b.inspection ? `<p class="muted">Returned at ${b.inspection.mileage.toLocaleString()} km · Fuel: ${esc(b.inspection.fuel)} · Damage: ${b.inspection.damage} · Deposit refunded: ${peso(b.refund)}</p>` : ''}
  ${acts.length ? `<div class="chips">${acts.join('')}</div>` : ''}</article>`;
}
function liveInfo(items, alerts) {
  const trips = items.length ? items.map(t => `<article class="card"><div class="row"><h3>${esc(t.name)}</h3><span class="chip s-active">${esc(t.vehicle.plate)}</span></div>
    ${kv('Distance left', t.remainingKm + ' km')}${kv('Estimated arrival', eta(t.etaMin))}${kv('Last GPS update', t.last ? fmtTime(t.last.at) : 'Waiting for GPS')}</article>`).join('')
    : '<div class="card"><p class="muted">No vehicles are on a trip right now. Start a rental from the Requests tab.</p></div>';
  const open = alerts.filter(a => !a.read);
  const al = `<div class="card stack"><h3>Alerts</h3>${open.length ? open.map(a => `<div class="row"><p><span class="chip s-pending">${label(a.type)}</span> ${esc(a.msg)}</p><button class="link" data-act="readAlert" data-id="${a.id}">Dismiss</button></div>`).join('') : '<p class="muted">No open alerts.</p>'}</div>`;
  return trips + al;
}
async function liveTick() {
  if (S.tab !== 'live' || S.view) return;
  const [items, alerts] = await Promise.all([api('/live'), api('/alerts')]).catch(() => [null]);
  if (!items || !$('#liveinfo')) return;
  $('#liveinfo').innerHTML = liveInfo(items, alerts); drawLive(items);
}
async function quote() {
  const f = $('form[data-form=book]'); if (!f) return;
  const d = Object.fromEntries(new FormData(f)), box = $('#quote');
  if (d.pickup === d.dropoff) { box.innerHTML = '<p class="muted">Choose different pick-up and drop-off places to see the price.</p>'; return; }
  try {
    const q = await api('/quote', 'POST', { vehicleId: S.view.vehicle.id, pickup: pl(d.pickup), dropoff: pl(d.dropoff), start: d.start, end: d.end });
    const v = S.view.vehicle;
    box.innerHTML = `<h3>Price breakdown</h3>${kv(`Rental (${q.days} day${q.days > 1 ? 's' : ''} × ${peso(v.ratePerDay)})`, peso(q.rental))}${kv(`Distance fee (${q.distanceKm} km × ${peso(v.ratePerKm)})`, peso(q.distanceFee))}
      ${kv('Security deposit (refundable)', peso(q.deposit))}${kv('Total', peso(q.total), 'total')}<p class="muted">Estimated drive time: ${q.etaHours} hours</p>`;
  } catch (e) { box.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}
function resize(file) {
  return new Promise((res, rej) => {
    const img = new Image(), r = new FileReader();
    r.onload = () => { img.onload = () => {
      const k = Math.min(1, 1100 / Math.max(img.width, img.height)), c = document.createElement('canvas');
      c.width = img.width * k; c.height = img.height * k; c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); res(c.toDataURL('image/jpeg', .82)); };
      img.onerror = () => rej(new Error('That file is not a readable image')); img.src = r.result; };
    r.onerror = () => rej(new Error('Could not read the file')); r.readAsDataURL(file);
  });
}
const vehicleForm = (v = {}, adding = false) =>
  field('name', 'Vehicle name', '', v.name) + `<div class="two"><div><label for="type">Type</label><select id="type" name="type">${['Van', 'Truck', 'Car', 'Utility'].map(t => `<option ${v.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>${field('plate', 'Plate number', '', v.plate)}</div>
  <div class="two">${field('seats', 'Seats', 'type="number" min="1"', v.seats ?? 4)}${field('geofenceKm', 'Safe zone (km)', 'type="number" min="1"', v.geofenceKm ?? 15)}</div>
  <div class="two">${field('ratePerDay', 'Rate per day (₱)', 'type="number" min="1"', v.ratePerDay)}${field('ratePerKm', 'Rate per km (₱)', 'type="number" min="1"', v.ratePerKm)}</div>
  <div class="two">${adding ? field('mileage', 'Current mileage (km)', 'type="number" min="0"', 0) : ''}${field('serviceEveryKm', 'Service every (km)', 'type="number" min="500"', v.serviceEveryKm ?? 5000)}</div>`;

/* ---------- click actions ---------- */
const byId = (list, id) => list.find(x => x.id === id);
const A = {
  auth: el => { S.auth = el.dataset.mode; authScreen(); },
  logout, reload: show, closeDlg: () => $('#dlg').close(),
  tab: el => { S.tab = el.dataset.tab; S.view = null; show(); },
  back: () => { S.view = null; show(); },
  type: el => { S.type = el.dataset.type; $('#types').innerHTML = typeChips(); $('#vlist').innerHTML = vlist(); },
  book: el => {
    if (S.user.licenseStatus !== 'verified') { toast('Upload your ID and wait for verification before booking'); S.tab = 'profile'; return show(); }
    S.view = { name: 'book', vehicle: byId(S.vehicles, el.dataset.id) }; show();
  },
  track: el => { S.view = { name: 'track', id: el.dataset.id }; show(); },
  share: () => {
    if (!navigator.geolocation) return toast('This device does not support GPS');
    stopTracking();
    S.watch = navigator.geolocation.watchPosition(p => sendLocation(S.view.id, p.coords.latitude, p.coords.longitude).catch(e => toast(e.message)),
      e => toast('Location is blocked: ' + e.message), { enableHighAccuracy: true, maximumAge: 5000 });
    toast('Sharing your live location');
  },
  sim: el => {
    stopTracking();
    const b = S.trackT.booking, detour = el.dataset.detour === '1', N = 30; let i = 0;
    S.sim = setInterval(async () => {
      i++; const t = i / N;
      const lat = b.pickup.lat + (b.dropoff.lat - b.pickup.lat) * t + (detour && t > .3 && t < .8 ? 0.45 * Math.sin(Math.PI * (t - .3) / .5) : 0);
      const lng = b.pickup.lng + (b.dropoff.lng - b.pickup.lng) * t;
      try { await sendLocation(b.id, lat, lng); } catch (e) { toast(e.message); stopTracking(); }
      if (i >= N) stopTracking();
    }, 1200);
    toast(detour ? 'Simulating a trip with a detour' : 'Simulating the trip');
  },
  stop: () => { stopTracking(); toast('Stopped sharing'); },
  bact: async el => { await api(`/bookings/${el.dataset.id}/action`, 'POST', { action: el.dataset.do }); toast('Booking updated'); show(); },
  returnForm: el => {
    const b = byId(S.bookings, el.dataset.id), v = byId(S.vehicles, b.vehicleId);
    dialog('Return inspection', `${field('mileage', 'Mileage at return (km)', `type="number" min="${v.mileage}"`, v.mileage)}
      <div><label for="fuel">Fuel level</label><select id="fuel" name="fuel">${['Full', '3/4', '1/2', '1/4', 'Empty'].map(x => `<option>${x}</option>`).join('')}</select></div>
      <div><label for="damage">Damage</label><select id="damage" name="damage"><option value="none">None</option><option value="minor">Minor</option><option value="major">Major</option></select></div>
      ${field('damageCharge', `Damage charge (₱, max ${peso(b.deposit)})`, 'type="number" min="0"', 0)}
      <div><label for="notes">Notes</label><textarea id="notes" name="notes"></textarea></div>`,
      d => api(`/bookings/${b.id}/return`, 'POST', d), 'Complete return');
  },
  reviewForm: el => {
    const id = el.dataset.id;
    dialog('Leave a review', `<div><label for="rating">Rating</label><select id="rating" name="rating">${[5, 4, 3, 2, 1].map(n => `<option value="${n}">${n} star${n > 1 ? 's' : ''}</option>`).join('')}</select></div>
      <div><label for="text">Comment</label><textarea id="text" name="text"></textarea></div>`, d => api('/reviews', 'POST', { ...d, bookingId: id }), 'Send review');
  },
  addVehicle: () => dialog('Add vehicle', vehicleForm({}, true), d => api('/vehicles', 'POST', d)),
  editVehicle: el => { const v = byId(S.vehicles, el.dataset.id); dialog('Edit vehicle', vehicleForm(v), d => api('/vehicles/' + v.id, 'PUT', d)); },
  service: el => {
    const v = byId(S.vehicles, el.dataset.id);
    dialog('Log maintenance', `<p class="muted">${esc(v.name)} · ${v.mileage.toLocaleString()} km</p>${field('note', 'Service done (for example, oil change)')}${field('km', 'Mileage at service (km)', 'type="number" min="0"', v.mileage)}${field('cost', 'Cost (₱)', 'type="number" min="0"', 0)}`,
      d => api('/maintenance', 'POST', { ...d, vehicleId: v.id }));
  },
  vstatus: async el => { await api('/vehicles/' + el.dataset.id, 'PUT', { status: el.dataset.to }); show(); },
  readAlert: async el => { await api(`/alerts/${el.dataset.id}/read`, 'POST'); liveTick(); },
  viewLicense: async el => {
    const { image } = await api('/admin/license/' + el.dataset.id), d = $('#dlg'), id = el.dataset.id;
    d.innerHTML = `<div class="stack"><h2>${esc(el.dataset.name)}</h2><img alt="ID photo" src="${image}">
      <div class="row"><button class="btn danger" data-act="decide" data-id="${id}" data-d="rejected">Reject</button><button class="btn" data-act="decide" data-id="${id}" data-d="verified">Verify</button></div>
      <button class="link" data-act="closeDlg">Close</button></div>`;
    d.showModal();
  },
  decide: async el => { await api('/admin/license/' + el.dataset.id, 'POST', { decision: el.dataset.d }); $('#dlg').close(); toast('ID ' + el.dataset.d); show(); }
};

/* ---------- form submits and live inputs ---------- */
const F = {
  auth: async f => {
    const d = Object.fromEntries(new FormData(f)), r = await api(S.auth === 'register' ? '/register' : '/login', 'POST', d);
    S.token = r.token; S.user = r.user; localStorage.setItem('rh_token', r.token); go();
  },
  book: async f => {
    const d = Object.fromEntries(new FormData(f));
    await api('/bookings', 'POST', { vehicleId: S.view.vehicle.id, service: d.service, pickup: pl(d.pickup), dropoff: pl(d.dropoff), start: d.start, end: d.end,
      signedName: d.signedName, agree: !!d.agree, method: d.method });
    toast('Booking sent to the owner'); S.view = null; S.tab = 'bookings'; show();
  },
  license: async f => {
    const file = f.file.files[0]; if (!file) return toast('Choose a photo of your ID');
    await api('/license', 'POST', { image: await resize(file) }); toast('ID uploaded. An admin will review it'); show();
  },
  expense: async f => { await api('/expenses', 'POST', Object.fromEntries(new FormData(f))); toast('Expense added'); show(); }
};
const I = { search: el => { S.q = el.value; $('#vlist').innerHTML = vlist(); }, quote };

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]'); if (!el || !A[el.dataset.act]) return;
  Promise.resolve(A[el.dataset.act](el)).catch(err => toast(err.message));
});
document.addEventListener('submit', e => {
  const f = e.target.closest('[data-form]'); if (!f) return;
  e.preventDefault(); Promise.resolve(F[f.dataset.form](f)).catch(err => toast(err.message));
});
document.addEventListener('input', e => { const el = e.target.closest('[data-oninput]'); if (el) I[el.dataset.oninput](el); });

/* ---------- start ---------- */
(async () => {
  if (S.token) { try { S.user = await api('/me'); return go(); } catch { /* token expired */ } }
  authScreen();
})();
})();
