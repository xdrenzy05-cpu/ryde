# RydeHaul

Mobile-first car rental management system with GPS-based vehicle monitoring.
Zero dependencies: you only need **Node.js 18 or newer** (nodejs.org).

**Brand:** logo, name, and colors come from the RydeHaul logo: road black `#121413` and signal orange `#FB9A0B`. Black is used for text and main buttons, orange for accents and the map. Logo files are in `public/` (`logo.png`, `logo-mark.png`, `favicon.png`).

## Run it (VS Code on Windows)
1. Unzip the folder and open it in VS Code (File > Open Folder).
2. Open the terminal (Ctrl + `) and run:  `npm start`
3. Open http://localhost:3000 in your browser.
4. Test: `npm test` (runs 18 automatic checks of the whole rental flow).

Data is saved in `data/db.json`. Delete the `data` folder to reset to the demo data.

## Demo accounts
| Role | Email | Password |
|---|---|---|
| Renter | renter@rydehaul.ph | renter123 |
| Car owner | owner@rydehaul.ph | owner123 |
| Super admin | admin@rydehaul.ph | admin123 |

## Try it on a phone
Phone and PC must be on the same Wi-Fi. Find the PC's IPv4 address (`ipconfig`) and open `http://<that-address>:3000` on the phone.
Note: browsers only allow real GPS on HTTPS or localhost, so on a phone over plain http use the **Simulate trip** buttons.
For real GPS, expose the app over HTTPS (for example with an ngrok tunnel).

## 5-minute demo script
1. **Renter:** register, upload a driver’s license or valid government ID photo (Profile).
2. **Admin:** Verify tab, review the ID, verify.
3. **Renter:** Browse, Book a vehicle. Watch the distance-based price update. Sign the contract, pick a payment method, confirm.
4. **Owner:** Requests, Approve, then Start rental (hand over).
5. **Renter:** Bookings, Track trip, press Simulate trip. Then Simulate detour.
6. **Owner:** Live map shows the vehicle and the off-route geofence alert.
7. **Owner:** Return and inspect (mileage, fuel, damage). The deposit is refunded minus damage.
8. Both sides leave reviews. **Owner:** Reports shows revenue, expenses, net income. Fleet shows service reminders.

## How it maps to the objectives
| Objective | Where in the system |
|---|---|
| 1. Mobile booking, confirmations, receipts | Browse, Book, Bookings (status flow: pending, approved, active, completed) |
| 2. Real-time GPS and geofencing | `/api/location`, `/api/track`, `/api/live`; alert when the vehicle is farther than the safe zone from its route |
| 3. Fleet and inventory management | Owner Fleet tab: availability status, maintenance log, service reminders by mileage |
| 4. Multi-role security | Renter, Owner, Admin roles; scrypt password hashing; signed tokens; ID upload and admin verification; typed-name contract signing; return inspection checklist |
| 5. Payments and reports | Payment methods and security deposit (simulated); Owner Reports; Admin Summary |

## How the main rules work
- **Price** = days x daily rate + distance km x per-km rate + 20% refundable security deposit.
- **Distance** = straight-line (haversine) distance x 1.3 to estimate road kilometers.
- **Geofence** = the vehicle's distance from the pick-up to drop-off route; farther than its safe zone (default 15 km) raises an alert.
- **Double booking** is blocked when dates overlap for the same vehicle.

## Project files
- `server.js`: REST API and static file server (Node built-ins only)
- `public/index.html`, `style.css`, `app.js`: the mobile-first web app
- `tests/smoke.js`: end-to-end checks
- `data/`: created on first run (database and license photos)

## Honest limitations (say these in your defense)
- Payments are **simulated**: no real GCash, Maya, or card gateway is connected.
- GPS comes from the phone's browser; there is no hardware tracker installed in the vehicles.
- Android-native app is not included: this is a mobile-first web app you can add to the home screen.
- Maps need internet (OpenStreetMap tiles). Routes are straight lines, not turn-by-turn.
- A JSON file is the database, which is fine for a prototype; use MySQL or PostgreSQL for production.
- Places are limited to Luzon presets (no ferry routes yet).
