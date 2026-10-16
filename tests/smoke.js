'use strict';
// Starts the server on a temporary database and walks through the whole rental flow.
const { spawn } = require('child_process');
const assert = require('assert');
const os = require('os'), fs = require('fs'), path = require('path');
const PORT = 3099, BASE = `http://localhost:${PORT}/api`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rydehaul-'));
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, DATA_DIR: dir }, stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function call(method, p, body, token) {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json() };
}
const ok = (name) => console.log('  ok  ' + name);
(async () => {
  try {
    await sleep(800);
    const login = async e => (await call('POST', '/login', { email: e + '@rydehaul.ph', password: e + '123' })).data;
    const R = await login('renter'), O = await login('owner'), A = await login('admin');
    assert(R.token && O.token && A.token); ok('logins for renter, owner, admin');
    assert.strictEqual((await call('POST', '/login', { email: 'renter@rydehaul.ph', password: 'bad' })).status, 401); ok('wrong password rejected');
    assert.strictEqual((await call('GET', '/admin/users', null, R.token)).status, 403); ok('renter blocked from admin API');
    const vs = (await call('GET', '/vehicles', null, R.token)).data; assert.strictEqual(vs.length, 4); ok('vehicle list');
    const v = vs[0], manila = { label: 'Manila', lat: 14.5995, lng: 120.9842 }, baguio = { label: 'Baguio', lat: 16.4023, lng: 120.596 };
    const today = new Date(Date.now() + 8 * 36e5).toISOString().slice(0, 10);
    const q = (await call('POST', '/quote', { vehicleId: v.id, pickup: manila, dropoff: baguio, start: today, end: today }, R.token)).data;
    assert(q.distanceKm > 200 && q.total > q.rental); ok('distance-based quote: ' + q.distanceKm + ' km, total ' + q.total);
    const body = { vehicleId: v.id, service: 'Travel', pickup: manila, dropoff: baguio, start: today, end: today, signedName: 'Maria Santos', agree: true, method: 'gcash' };
    const b = (await call('POST', '/bookings', body, R.token)).data; assert.strictEqual(b.status, 'pending'); ok('booking created (pending)');
    assert.strictEqual((await call('POST', '/bookings', body, R.token)).status, 409); ok('double booking blocked');
    assert.strictEqual((await call('POST', `/bookings/${b.id}/action`, { action: 'approve' }, R.token)).status, 403); ok('renter cannot approve');
    await call('POST', `/bookings/${b.id}/action`, { action: 'approve' }, O.token);
    assert.strictEqual((await call('POST', '/location', { bookingId: b.id, lat: 15, lng: 120.8 }, R.token)).status, 409); ok('GPS rejected before rental starts');
    await call('POST', `/bookings/${b.id}/action`, { action: 'start' }, O.token);
    const onRoute = (await call('POST', '/location', { bookingId: b.id, lat: 15.5, lng: 120.7 }, R.token)).data; assert.strictEqual(onRoute.outside, false); ok('on-route GPS point accepted');
    const off = (await call('POST', '/location', { bookingId: b.id, lat: 15.5, lng: 121.9 }, R.token)).data; assert.strictEqual(off.outside, true); ok('geofence detects detour (' + off.offRouteKm + ' km)');
    const al = (await call('GET', '/alerts', null, O.token)).data; assert(al.some(a => a.type === 'geofence')); ok('owner received geofence alert');
    const live = (await call('GET', '/live', null, O.token)).data; assert.strictEqual(live.length, 1); ok('live map data');
    const ret = (await call('POST', `/bookings/${b.id}/return`, { mileage: v.mileage + 600, fuel: 'Full', damage: 'minor', damageCharge: 500 }, O.token)).data;
    assert.strictEqual(ret.status, 'completed'); assert.strictEqual(ret.refund, ret.deposit - 500); ok('return inspection, deposit refund ' + ret.refund);
    assert.strictEqual((await call('POST', '/reviews', { bookingId: b.id, rating: 5, text: 'Great' }, R.token)).status, 200);
    assert.strictEqual((await call('POST', '/reviews', { bookingId: b.id, rating: 5 }, O.token)).status, 200); ok('mutual reviews');
    const rep = (await call('GET', '/report', null, O.token)).data; assert(rep.trips === 2 && rep.revenue > 0); ok('owner report: revenue ' + rep.revenue);
    const n = (await call('POST', '/register', { name: 'New Renter', email: 'new@x.ph', password: 'secret1', role: 'renter' })).data;
    assert.strictEqual((await call('POST', '/bookings', body, n.token)).status, 403); ok('unverified renter cannot book');
    const img = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBD';
    await call('POST', '/license', { image: img }, n.token);
    await call('POST', `/admin/license/${n.user.id}`, { decision: 'verified' }, A.token);
    assert.strictEqual((await call('GET', '/me', null, n.token)).data.licenseStatus, 'verified'); ok('license upload and admin verification');
    console.log('\nAll checks passed.');
  } catch (e) { console.error('\nFAILED:', e.message); process.exitCode = 1; }
  finally { srv.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
})();
