'use strict';
/**
 * RydeHaul server - zero dependencies (only Node.js built-ins).
 *  - REST API under /api/*  (JSON)
 *  - serves the web app in /public
 *  - data is stored in data/db.json (created and seeded on first run)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const SECRET = process.env.SECRET || 'rydehaul-dev-secret-change-me';
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA, 'db.json');
const UPLOADS = path.join(DATA, 'uploads');
const PUB = path.join(__dirname, 'public');

// Business rules (easy to explain during the defense)
const DEPOSIT_RATE = 0.2;   // security deposit = 20% of rental + distance fee
const ROAD_FACTOR = 1.3;    // straight-line km x 1.3 = estimated road km
const AVG_KMH = 50;         // used for the arrival estimate
const GEOFENCE_COOLDOWN_MS = 2 * 60 * 1000;

/* ---------- small helpers ---------- */
const now = () => new Date().toISOString();
const todayStr = () => new Date(Date.now() + 8 * 36e5).toISOString().slice(0, 10); // Philippine date (UTC+8)
const uid = p => p + '_' + crypto.randomBytes(5).toString('hex');
const str = x => String(x ?? '').trim();
const round = (n, d = 0) => Math.round(n * 10 ** d) / 10 ** d;
const bad = (status, msg) => { const e = new Error(msg); e.status = status; throw e; };

/* ---------- storage (JSON file, atomic save) ---------- */
let db;
function save() {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
function load() {
  if (fs.existsSync(DB_FILE)) { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); return; }
  db = seed(); save();
}

/* ---------- security: password hashing and signed tokens ---------- */
const hash = (pw, salt = crypto.randomBytes(16).toString('hex')) =>
  salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
function checkPw(pw, stored) {
  const [salt, key] = stored.split(':');
  const a = Buffer.from(key, 'hex'), b = crypto.scryptSync(pw, salt, 32);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const sign = d => crypto.createHmac('sha256', SECRET).update(d).digest('base64url');
const makeToken = u => {
  const p = Buffer.from(JSON.stringify({ id: u.id, exp: Date.now() + 7 * 864e5 })).toString('base64url');
  return p + '.' + sign(p);
};
function userFromToken(t) {
  if (!t) return null;
  const [p, s] = t.split('.');
  if (!p || !s || sign(p) !== s) return null;
  try {
    const d = JSON.parse(Buffer.from(p, 'base64url').toString());
    return d.exp > Date.now() ? db.users.find(u => u.id === d.id) || null : null;
  } catch { return null; }
}

/* ---------- geo and pricing ---------- */
const rad = x => x * Math.PI / 180;
function haversine(a, b) { // km between two coordinates
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
function distToRoute(p, a, b) { // km from point p to the straight route a->b (geofence corridor)
  const k = Math.cos(rad((a.lat + b.lat) / 2));
  const X = q => q.lng * k * 111.32, Y = q => q.lat * 110.574;
  const [px, py, ax, ay, bx, by] = [X(p), Y(p), X(a), Y(a), X(b), Y(b)];
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function quote(v, pickup, dropoff, start, end) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(start) || !re.test(end)) bad(400, 'Choose pick-up and return dates');
  const days = Math.round((new Date(end) - new Date(start)) / 864e5) + 1;
  if (days < 1) bad(400, 'Return date must be on or after the pick-up date');
  const distanceKm = round(haversine(pickup, dropoff) * ROAD_FACTOR, 1);
  const rental = days * v.ratePerDay;
  const distanceFee = Math.round(distanceKm * v.ratePerKm);
  const deposit = Math.round((rental + distanceFee) * DEPOSIT_RATE);
  return { days, distanceKm, rental, distanceFee, deposit, total: rental + distanceFee + deposit,
           etaHours: round(distanceKm / AVG_KMH, 1) };
}
const place = p => {
  const lat = +p?.lat, lng = +p?.lng;
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) bad(400, 'Choose valid pick-up and drop-off places');
  return { label: str(p.label).slice(0, 60) || 'Custom', lat, lng };
};

/* ---------- serializers ---------- */
const pubUser = u => { const { pass, ...rest } = u; return rest; };
const avgRating = id => {
  const r = db.reviews.filter(x => x.toId === id);
  return r.length ? round(r.reduce((s, x) => s + x.rating, 0) / r.length, 1) : null;
};
function vehicleOut(v) {
  const owner = db.users.find(u => u.id === v.ownerId);
  const used = v.mileage - v.lastServiceKm;
  return { ...v, ownerName: owner?.name, ownerRating: avgRating(v.ownerId),
           kmToService: v.serviceEveryKm - used, serviceDue: used >= v.serviceEveryKm };
}
function bookingOut(b, viewer) {
  const v = db.vehicles.find(x => x.id === b.vehicleId);
  const renter = db.users.find(u => u.id === b.renterId);
  return { ...b, vehicleName: v?.name, plate: v?.plate, vehicleType: v?.type, renterName: renter?.name,
           renterRating: avgRating(b.renterId), ownerRating: avgRating(v?.ownerId),
           myReview: db.reviews.some(r => r.bookingId === b.id && r.fromId === viewer.id) };
}
const bookingsFor = u => db.bookings.filter(b => {
  if (u.role === 'admin') return true;
  if (u.role === 'renter') return b.renterId === u.id;
  return db.vehicles.find(v => v.id === b.vehicleId)?.ownerId === u.id;
});
const addAlert = (b, v, type, msg) =>
  db.alerts.unshift({ id: uid('al'), bookingId: b?.id, vehicleId: v.id, ownerId: v.ownerId, type, msg, at: now(), read: false });

/* ---------- routing ---------- */
const routes = [];
const ANY = ['renter', 'owner', 'admin'];
const add = (m, p, roles, fn) =>
  routes.push({ m, roles, fn, re: new RegExp('^' + p.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$') });

/* ----- auth ----- */
add('POST', '/api/register', null, ({ body }) => {
  const name = str(body.name), email = str(body.email).toLowerCase(), pw = String(body.password || ''), role = body.role;
  if (name.length < 2) bad(400, 'Enter your full name');
  if (!/^\S+@\S+\.\S+$/.test(email)) bad(400, 'Enter a valid email');
  if (pw.length < 6) bad(400, 'Password needs at least 6 characters');
  if (!['renter', 'owner'].includes(role)) bad(400, 'Choose Renter or Car Owner');
  if (db.users.some(u => u.email === email)) bad(409, 'That email is already registered');
  const u = { id: uid('u'), name, email, phone: str(body.phone), role, pass: hash(pw),
              licenseStatus: role === 'renter' ? 'none' : 'n/a', createdAt: now() };
  db.users.push(u); save();
  return { token: makeToken(u), user: pubUser(u) };
});
add('POST', '/api/login', null, ({ body }) => {
  const u = db.users.find(x => x.email === str(body.email).toLowerCase());
  if (!u || !checkPw(String(body.password || ''), u.pass)) bad(401, 'Wrong email or password');
  return { token: makeToken(u), user: pubUser(u) };
});
add('GET', '/api/me', ANY, ({ user }) => pubUser(user));

/* ----- driver's license verification ----- */
add('POST', '/api/license', ['renter'], ({ user, body }) => {
  const img = String(body.image || '');
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(img)) bad(400, 'Upload a JPG or PNG photo of your ID');
  if (img.length > 3e6) bad(413, 'Photo is too large. Use a smaller image');
  fs.mkdirSync(UPLOADS, { recursive: true });
  fs.writeFileSync(path.join(UPLOADS, user.id + '.txt'), img);
  user.licenseStatus = 'pending'; save();
  return pubUser(user);
});

/* ----- vehicles (fleet management) ----- */
add('GET', '/api/vehicles', ANY, ({ user }) =>
  db.vehicles.filter(v => user.role !== 'owner' || v.ownerId === user.id).map(vehicleOut));
function vehicleFields(b, v = {}) {
  const num = (x, d) => (isFinite(+x) && +x >= 0 && x !== '' ? +x : d);
  const out = {
    name: str(b.name ?? v.name), type: str(b.type ?? v.type) || 'Van', plate: str(b.plate ?? v.plate).toUpperCase(),
    seats: num(b.seats, v.seats ?? 4), ratePerDay: num(b.ratePerDay, v.ratePerDay), ratePerKm: num(b.ratePerKm, v.ratePerKm),
    serviceEveryKm: num(b.serviceEveryKm, v.serviceEveryKm ?? 5000), geofenceKm: num(b.geofenceKm, v.geofenceKm ?? 15)
  };
  if (out.name.length < 2 || out.plate.length < 3) bad(400, 'Enter the vehicle name and plate number');
  if (!out.ratePerDay || !out.ratePerKm) bad(400, 'Enter the daily rate and the per-km rate');
  return out;
}
add('POST', '/api/vehicles', ['owner'], ({ user, body }) => {
  const f = vehicleFields(body), mileage = isFinite(+body.mileage) ? +body.mileage : 0;
  const v = { id: uid('v'), ownerId: user.id, ...f, status: 'available', mileage, lastServiceKm: mileage, last: null };
  db.vehicles.push(v); save(); return vehicleOut(v);
});
add('PUT', '/api/vehicles/:id', ['owner'], ({ user, params, body }) => {
  const v = db.vehicles.find(x => x.id === params.id && x.ownerId === user.id);
  if (!v) bad(404, 'Vehicle not found');
  Object.assign(v, vehicleFields(body, v));
  if (body.status) {
    if (!['available', 'maintenance'].includes(body.status)) bad(400, 'Status can be Available or Maintenance');
    if (v.status === 'rented') bad(409, 'This vehicle is on a trip. Complete the return first');
    v.status = body.status;
  }
  save(); return vehicleOut(v);
});

/* ----- maintenance log and expenses ----- */
add('GET', '/api/maintenance', ['owner'], ({ user }) => {
  const mine = new Set(db.vehicles.filter(v => v.ownerId === user.id).map(v => v.id));
  return db.maintenance.filter(m => mine.has(m.vehicleId)).map(m => ({ ...m, vehicleName: db.vehicles.find(v => v.id === m.vehicleId)?.name }));
});
add('POST', '/api/maintenance', ['owner'], ({ user, body }) => {
  const v = db.vehicles.find(x => x.id === body.vehicleId && x.ownerId === user.id);
  if (!v) bad(404, 'Vehicle not found');
  const km = isFinite(+body.km) && body.km !== '' ? +body.km : v.mileage, cost = +body.cost || 0;
  if (!str(body.note)) bad(400, 'Describe the service done');
  db.maintenance.unshift({ id: uid('m'), vehicleId: v.id, note: str(body.note), cost, km, at: now() });
  v.lastServiceKm = km; v.mileage = Math.max(v.mileage, km);
  if (cost > 0) db.expenses.unshift({ id: uid('e'), ownerId: user.id, label: 'Maintenance: ' + v.name, amount: cost, at: now() });
  save(); return vehicleOut(v);
});
add('GET', '/api/expenses', ['owner'], ({ user }) => db.expenses.filter(e => e.ownerId === user.id));
add('POST', '/api/expenses', ['owner'], ({ user, body }) => {
  const amount = +body.amount;
  if (!str(body.label) || !(amount > 0)) bad(400, 'Enter what the expense was for and the amount');
  db.expenses.unshift({ id: uid('e'), ownerId: user.id, label: str(body.label), amount, at: now() });
  save(); return { ok: true };
});

/* ----- quote and booking ----- */
add('POST', '/api/quote', ['renter'], ({ body }) => {
  const v = db.vehicles.find(x => x.id === body.vehicleId);
  if (!v) bad(404, 'Vehicle not found');
  return quote(v, place(body.pickup), place(body.dropoff), str(body.start), str(body.end));
});
add('POST', '/api/bookings', ['renter'], ({ user, body }) => {
  if (user.licenseStatus !== 'verified') bad(403, "Your ID must be verified before you can book");
  const v = db.vehicles.find(x => x.id === body.vehicleId);
  if (!v) bad(404, 'Vehicle not found');
  if (v.status === 'maintenance') bad(409, 'This vehicle is under maintenance');
  const pickup = place(body.pickup), dropoff = place(body.dropoff), start = str(body.start), end = str(body.end);
  const q = quote(v, pickup, dropoff, start, end);
  if (start < todayStr()) bad(400, 'Pick-up date cannot be in the past');
  const clash = db.bookings.some(b => b.vehicleId === v.id && ['pending', 'approved', 'active'].includes(b.status) && start <= b.end && b.start <= end);
  if (clash) bad(409, 'This vehicle is already booked for those dates. Try other dates');
  const signedName = str(body.signedName);
  if (!body.agree || signedName.length < 3) bad(400, 'Accept the rental contract and type your full name to sign');
  const method = body.method;
  if (!['gcash', 'maya', 'card', 'cash'].includes(method)) bad(400, 'Choose a payment method');
  const b = { id: uid('b'), renterId: user.id, vehicleId: v.id, service: str(body.service) || 'Travel', start, end, pickup, dropoff,
    ...q, status: 'pending', contract: { signedName, signedAt: now() },
    // Payments are SIMULATED in this prototype (no real gateway connected)
    payment: { method, status: method === 'cash' ? 'pay on pickup' : 'paid', ref: 'SIM-' + crypto.randomBytes(3).toString('hex').toUpperCase() },
    createdAt: now() };
  db.bookings.unshift(b); save(); return bookingOut(b, user);
});
add('GET', '/api/bookings', ANY, ({ user }) => bookingsFor(user).map(b => bookingOut(b, user)));

add('POST', '/api/bookings/:id/action', ['renter', 'owner'], ({ user, params, body }) => {
  const b = bookingsFor(user).find(x => x.id === params.id);
  if (!b) bad(404, 'Booking not found');
  const v = db.vehicles.find(x => x.id === b.vehicleId), a = body.action;
  const need = (...s) => { if (!s.includes(b.status)) bad(409, `This booking is already ${b.status}`); };
  if (user.role === 'renter' && a === 'cancel') { need('pending', 'approved'); b.status = 'cancelled'; }
  else if (user.role === 'owner' && a === 'approve') { need('pending'); b.status = 'approved'; }
  else if (user.role === 'owner' && a === 'reject') { need('pending'); b.status = 'rejected'; }
  else if (user.role === 'owner' && a === 'start') { need('approved'); b.status = 'active'; b.startedAt = now(); v.status = 'rented'; }
  else bad(403, 'That action is not allowed');
  save(); return bookingOut(b, user);
});
add('POST', '/api/bookings/:id/return', ['owner'], ({ user, params, body }) => {
  const b = bookingsFor(user).find(x => x.id === params.id);
  if (!b) bad(404, 'Booking not found');
  if (b.status !== 'active') bad(409, 'Only an active rental can be returned');
  const v = db.vehicles.find(x => x.id === b.vehicleId), mileage = +body.mileage;
  if (!isFinite(mileage) || mileage < v.mileage) bad(400, `Return mileage must be at least ${v.mileage} km`);
  if (!['none', 'minor', 'major'].includes(body.damage)) bad(400, 'Choose the damage level');
  const charge = Math.min(Math.max(+body.damageCharge || 0, 0), b.deposit);
  b.inspection = { mileage, fuel: str(body.fuel) || 'Full', damage: body.damage, damageCharge: charge, notes: str(body.notes), at: now() };
  b.refund = b.deposit - charge; b.status = 'completed'; b.completedAt = now();
  v.status = 'available'; v.mileage = mileage;
  if (mileage - v.lastServiceKm >= v.serviceEveryKm) addAlert(b, v, 'service', `${v.name} (${v.plate}) is due for maintenance.`);
  save(); return bookingOut(b, user);
});

/* ----- GPS tracking and geofencing ----- */
add('POST', '/api/location', ['renter', 'owner'], ({ user, body }) => {
  const b = bookingsFor(user).find(x => x.id === body.bookingId);
  const lat = +body.lat, lng = +body.lng;
  if (!b || b.status !== 'active') bad(409, 'Tracking works only during an active rental');
  if (!isFinite(lat) || !isFinite(lng)) bad(400, 'Invalid location');
  const v = db.vehicles.find(x => x.id === b.vehicleId);
  v.last = { lat, lng, at: now() };
  db.locations.push({ bookingId: b.id, lat, lng, at: now() });
  const mine = db.locations.filter(l => l.bookingId === b.id);
  if (mine.length > 300) db.locations.splice(db.locations.indexOf(mine[0]), mine.length - 300);
  const off = distToRoute({ lat, lng }, b.pickup, b.dropoff);
  const outside = off > v.geofenceKm;
  if (outside) {
    const recent = db.alerts.find(a => a.bookingId === b.id && a.type === 'geofence' && Date.now() - Date.parse(a.at) < GEOFENCE_COOLDOWN_MS);
    if (!recent) addAlert(b, v, 'geofence', `${v.name} (${v.plate}) is ${round(off, 1)} km away from its route. The safe zone is ${v.geofenceKm} km.`);
  }
  save(); return { outside, offRouteKm: round(off, 1) };
});
function trackData(b) {
  const v = db.vehicles.find(x => x.id === b.vehicleId);
  const remainingKm = v.last ? round(haversine(v.last, b.dropoff) * ROAD_FACTOR, 1) : b.distanceKm;
  return { booking: { id: b.id, status: b.status, pickup: b.pickup, dropoff: b.dropoff, distanceKm: b.distanceKm },
    vehicle: { name: v.name, plate: v.plate, geofenceKm: v.geofenceKm }, last: v.last,
    trail: db.locations.filter(l => l.bookingId === b.id).slice(-200),
    remainingKm, etaMin: Math.round(remainingKm / AVG_KMH * 60),
    alerts: db.alerts.filter(a => a.bookingId === b.id && a.type === 'geofence').slice(0, 5) };
}
add('GET', '/api/track/:id', ANY, ({ user, params }) => {
  const b = bookingsFor(user).find(x => x.id === params.id);
  if (!b) bad(404, 'Booking not found');
  return trackData(b);
});
add('GET', '/api/live', ['owner', 'admin'], ({ user }) =>
  bookingsFor(user).filter(b => b.status === 'active').map(b => ({ ...trackData(b), name: db.vehicles.find(v => v.id === b.vehicleId).name })));
add('GET', '/api/alerts', ['owner'], ({ user }) => db.alerts.filter(a => a.ownerId === user.id).slice(0, 30));
add('POST', '/api/alerts/:id/read', ['owner'], ({ user, params }) => {
  const a = db.alerts.find(x => x.id === params.id && x.ownerId === user.id);
  if (a) { a.read = true; save(); }
  return { ok: true };
});

/* ----- mutual reviews ----- */
add('POST', '/api/reviews', ['renter', 'owner'], ({ user, body }) => {
  const b = bookingsFor(user).find(x => x.id === body.bookingId);
  if (!b || b.status !== 'completed') bad(409, 'You can review a rental after it is completed');
  if (db.reviews.some(r => r.bookingId === b.id && r.fromId === user.id)) bad(409, 'You already reviewed this rental');
  const rating = Math.round(+body.rating);
  if (!(rating >= 1 && rating <= 5)) bad(400, 'Rating must be from 1 to 5');
  const ownerId = db.vehicles.find(v => v.id === b.vehicleId).ownerId;
  db.reviews.push({ id: uid('r'), bookingId: b.id, fromId: user.id, toId: user.role === 'renter' ? ownerId : b.renterId,
                    rating, text: str(body.text).slice(0, 300), at: now() });
  save(); return { ok: true };
});

/* ----- reports ----- */
const earned = b => b.rental + b.distanceFee + (b.inspection?.damageCharge || 0);
add('GET', '/api/report', ['owner'], ({ user }) => {
  const done = bookingsFor(user).filter(b => b.status === 'completed');
  const revenue = done.reduce((s, b) => s + earned(b), 0);
  const expenses = db.expenses.filter(e => e.ownerId === user.id);
  const spent = expenses.reduce((s, e) => s + e.amount, 0);
  return { revenue, spent, net: revenue - spent, trips: done.length, expenses,
           history: done.map(b => ({ ...bookingOut(b, user), earned: earned(b) })) };
});

/* ----- admin ----- */
add('GET', '/api/admin/users', ['admin'], () => db.users.map(pubUser));
add('GET', '/api/admin/license/:id', ['admin'], ({ params }) => {
  const f = path.join(UPLOADS, path.basename(params.id) + '.txt');
  if (!fs.existsSync(f)) bad(404, 'No ID uploaded');
  return { image: fs.readFileSync(f, 'utf8') };
});
add('POST', '/api/admin/license/:id', ['admin'], ({ params, body }) => {
  const u = db.users.find(x => x.id === params.id && x.role === 'renter');
  if (!u) bad(404, 'User not found');
  if (!['verified', 'rejected'].includes(body.decision)) bad(400, 'Choose verify or reject');
  u.licenseStatus = body.decision; save(); return pubUser(u);
});
add('GET', '/api/admin/report', ['admin'], () => {
  const by = (arr, k) => arr.reduce((m, x) => (m[x[k]] = (m[x[k]] || 0) + 1, m), {});
  const done = db.bookings.filter(b => b.status === 'completed');
  return { users: by(db.users, 'role'), vehicles: db.vehicles.length, bookings: by(db.bookings, 'status'),
           revenue: done.reduce((s, b) => s + earned(b), 0), pendingLicenses: db.users.filter(u => u.licenseStatus === 'pending').length,
           alerts: db.alerts.length };
});

/* ---------- HTTP server ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
               '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
  res.end(body);
}
const json = (res, code, obj) => send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8');
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 4e6) { reject(Object.assign(new Error('Upload is too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch { reject(Object.assign(new Error('Invalid request'), { status: 400 })); } });
    req.on('error', reject);
  });
}
function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const f = path.normalize(path.join(PUB, p));
  if (f !== PUB && !f.startsWith(PUB + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(f, (e, d) => e ? send(res, 404, 'Not found', 'text/plain') : send(res, 200, d, MIME[path.extname(f)] || 'application/octet-stream'));
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res);
    let params;
    const r = routes.find(x => x.m === req.method && (params = x.re.exec(url.pathname)?.groups || (x.re.test(url.pathname) ? {} : null)));
    if (!r) bad(404, 'Unknown endpoint');
    const user = userFromToken((req.headers.authorization || '').replace('Bearer ', ''));
    if (r.roles && (!user || !r.roles.includes(user.role))) bad(user ? 403 : 401, user ? 'Your role cannot do this' : 'Please log in');
    const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};
    json(res, 200, await r.fn({ user, body, params, query: Object.fromEntries(url.searchParams) }) ?? { ok: true });
  } catch (e) {
    if (!e.status) console.error(e);
    json(res, e.status || 500, { error: e.status ? e.message : 'Server error. Please try again' });
  }
});

/* ---------- demo data (first run only) ---------- */
function seed() {
  const d = { users: [], vehicles: [], bookings: [], locations: [], alerts: [], maintenance: [], expenses: [], reviews: [] };
  const mk = (name, email, pw, role, extra = {}) => { const u = { id: uid('u'), name, email, phone: '09170000000', role, pass: hash(pw), licenseStatus: role === 'renter' ? 'verified' : 'n/a', createdAt: now(), ...extra }; d.users.push(u); return u; };
  mk('Admin RydeHaul', 'admin@rydehaul.ph', 'admin123', 'admin');
  const owner = mk('Juan Dela Cruz (Owner)', 'owner@rydehaul.ph', 'owner123', 'owner');
  const renter = mk('Maria Santos (Renter)', 'renter@rydehaul.ph', 'renter123', 'renter');
  const veh = (name, type, plate, seats, ratePerDay, ratePerKm, mileage, lastServiceKm) =>
    ({ id: uid('v'), ownerId: owner.id, name, type, plate, seats, ratePerDay, ratePerKm, status: 'available', mileage, lastServiceKm, serviceEveryKm: 5000, geofenceKm: 15, last: null });
  d.vehicles.push(veh('Toyota Hiace Van', 'Van', 'NBC 1234', 12, 3500, 18, 41200, 38000), veh('Isuzu Elf Truck', 'Truck', 'ABX 5521', 3, 4800, 25, 66800, 62500),
                  veh('Toyota Vios', 'Car', 'DAN 9087', 5, 1800, 10, 24500, 20000), veh('Mitsubishi L300 FB', 'Utility', 'CAV 3310', 3, 3200, 20, 30200, 25000));
  const v = d.vehicles[0], pickup = { label: 'Manila', lat: 14.5995, lng: 120.9842 }, dropoff = { label: 'Baguio', lat: 16.4023, lng: 120.596 };
  db = d; // quote() reads nothing from db, safe
  const q = quote(v, pickup, dropoff, '2026-09-01', '2026-09-03');
  d.bookings.push({ id: uid('b'), renterId: renter.id, vehicleId: v.id, service: 'Travel', start: '2026-09-01', end: '2026-09-03', pickup, dropoff, ...q,
    status: 'completed', contract: { signedName: renter.name, signedAt: '2026-08-30T08:00:00.000Z' }, payment: { method: 'gcash', status: 'paid', ref: 'SIM-DEMO01' },
    inspection: { mileage: 41200, fuel: 'Full', damage: 'none', damageCharge: 0, notes: 'Clean return', at: '2026-09-03T10:00:00.000Z' }, refund: q.deposit,
    createdAt: '2026-08-30T08:00:00.000Z', completedAt: '2026-09-03T10:00:00.000Z' });
  return d;
}

load();
server.listen(PORT, () => {
  console.log(`RydeHaul running at http://localhost:${PORT}`);
  console.log('Demo logins: admin@rydehaul.ph / admin123 | owner@rydehaul.ph / owner123 | renter@rydehaul.ph / renter123');
});
