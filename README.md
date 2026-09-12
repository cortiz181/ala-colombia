# ALA MVP

A working starter MVP for a Colombian flight-deal subscription business.

## What works now
- Public landing page
- Deal board with filters
- Registration / login
- User airport preferences
- Free / Premium / Premium+ tiers
- Premium deal locking
- Admin dashboard
- Admin deal publishing
- SQLite database
- Demo seed data
- Resend email integration when configured
- WhatsApp Cloud API integration when configured
- Wompi configuration placeholders and subscription flow hooks
- CSV/API fare-ingestion-ready service functions

## Run locally

```bash
python -m venv .venv
source .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
python app.py
```

Open: http://127.0.0.1:5000

The database is created automatically.

## Admin
Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env`.
Log in with those credentials and visit `/admin`.

## External services
The app still runs without external credentials. When keys are missing, email/WhatsApp functions log the alert instead of sending it.

### Resend
Set:
- `RESEND_API_KEY`
- `FROM_EMAIL`

### WhatsApp Cloud API
Set:
- `WHATSAPP_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`

### Wompi
Production checkout/webhook endpoints should be completed after your merchant account is created because Wompi credentials, acceptance tokens, integrity signatures, approved payment methods, and recurrent billing configuration are merchant-specific.

## Production changes before launch
1. Use Postgres instead of SQLite.
2. Put the app behind HTTPS.
3. Configure CSRF protection.
4. Add email verification / password reset.
5. Finish Wompi checkout + webhook signature validation.
6. Connect a flight data provider / metasearch affiliate feed.
7. Add scheduled fare scans.
8. Add Colombian privacy policy, terms, cancellation policy, and Habeas Data consent.
9. Add analytics and conversion tracking.
10. Add a queue (Celery/RQ) for bulk alerts.

## Suggested deployment
- App: Railway / Render / Fly.io
- DB: Managed Postgres
- Email: Resend
- Payments: Wompi
- WhatsApp: Meta Cloud API
