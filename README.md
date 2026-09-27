# My Doas App

Quranic Doas with Arabic, transliteration, meaning and recitation, behind a yearly plan ($16 by card, or ₹1,299 via UPI).
Charcoal linen wall, pink Arabic lettering, cream Latin text. Installable as a PWA (Android Chrome, iPhone Safari "Add to Home Screen").

## What is in this version
- 38 Doas, including Surah Ad-Duha (93:1–11) and the Doas from the last part of the Qur'an (An-Nasr, Al-Falaq, An-Nas), under the "Last part of the Qur'an" filter.
- The "read from a trusted source" disclaimer is removed.
- The Doas are served by the server only after payment is verified (`data/doas.json`), so the app cannot be used without paying.
- Two payment paths, each optional and independent (see below): Stripe Checkout for cards, and a UPI QR for instant self-serve unlock. No Razorpay.

## Deploy on Render
1. Replace the files in your GitHub repo with this folder's contents (keep `server.js` and `package.json` at the top level).
2. Render service settings: Build command `npm install` (or leave empty), Start command `node server.js`.
3. Render > Environment, add:
   - `TOKEN_SECRET`   (any long random string; signs unlock tokens)
   - `ADMIN_SECRET`   (any long passphrase, protects `/admin` — the UPI claims log and optional code tool)
   - `STRIPE_SECRET_KEY` (optional — see Card payments below; without it, the card button stays disabled)
4. Redeploy. Open `https://my-doas-app.onrender.com/api/config` to confirm it's live.

## Payment flow

**Card payments (Stripe Checkout)** — "Pay by card" on the front page sends the browser to a Stripe-hosted checkout page (server-created, no Stripe JS widget). Stripe redirects back after the attempt, and the server confirms payment status directly with Stripe's API before unlocking — nothing is trusted from the browser. Set in Render's Environment:
- `STRIPE_SECRET_KEY` (starts with `sk_test_` while testing, `sk_live_` once your Stripe account is verified)
- `PRICE_USD` — optional, default 16 (set your own international price; there's no automatic ₹→$ conversion)

Stripe needs your own verified business account before it can take real payments — same as any payment gateway, I can't create or verify that for you. Two things worth knowing before you sign up: it requires KYC similar to what Razorpay asked for, and **Stripe India only accepts payments from customers outside India** for Indian merchants — it's built for international buyers, not a domestic replacement. PayPal has the same "verified Business account" requirement if you'd rather use that instead — ask me and I'll wire it up the same way once you have keys.

**UPI — instant, self-serve unlock.** A buyer scans the QR (pre-filled to ₹1,299), pays with any UPI app, then taps "I've paid — Unlock" and gets in immediately. **This is not verified against your bank or UPI app in any way** — it's an honor-system unlock, not a payment confirmation. Every tap is logged (timestamp + whatever note the buyer typed, if any) so you can reconcile against your own UPI app afterwards. Open `https://my-doas-app.onrender.com/admin`, enter your `ADMIN_SECRET` passphrase, and tap **Load claims** to see the log. If this gets abused, a stricter one-time-code flow is still in the code, unused (see the admin page's "Issue a code" section) — ask me to switch the front-end button back to it.

**The raw UPI ID/phone number is not shown as text anywhere in the app** — only encoded inside the QR image itself, which is what makes it scannable.

**UPI cannot take payments from foreign bank cards or non-Indian accounts** — it's a domestic Indian payment network. That's what Stripe is for.

## Test card (Stripe test mode)
Stripe's test card: 4242 4242 4242 4242, any future expiry, any CVC, any postal code.

## Known limits
- The unlock is stored on the device (browser storage). Clearing browser data, or opening the app on a second phone, asks for payment again. A "restore purchase" step needs user accounts, which this version does not have.
- Google Play: if you publish this on Google Play, Google's payments policy generally requires Google Play Billing for digital subscriptions. Check this before you submit.
- The UPI claims log (`data/upi-claims.json`) lives on the server's local disk. On Render's free tier that can reset on redeploy or after inactivity — fine for reconciling a small volume by hand, not a permanent record.
