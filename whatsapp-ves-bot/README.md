# WhatsApp VES Exchange Bot MVP

Customer-facing WhatsApp flow for USD → VES quotes and recipient collection, plus Plaid transaction reconciliation and manual admin payout approval.

## Environment variables
- DATABASE_URL
- ADMIN_KEY
- PUBLIC_BASE_URL
- WHATSAPP_VERIFY_TOKEN
- WHATSAPP_ACCESS_TOKEN
- WHATSAPP_PHONE_NUMBER_ID
- META_GRAPH_VERSION
- PLAID_CLIENT_ID
- PLAID_SECRET
- PLAID_ENV=sandbox|production

Bank matches only mark orders as `payment_detected`; they never trigger an automatic VES payout.