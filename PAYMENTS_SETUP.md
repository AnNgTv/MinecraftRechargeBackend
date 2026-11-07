# NIGHTMARE TCYT bank payments

## Current behavior
- Base conversion: 10,000 VND = 100 PlayerPoints (10 points per 1,000 VND).
- Recharge bonus: 0% by default.
- Donation bonus: +5%.
- Event bonus: `PAYMENT_EVENT_BONUS_PERCENT`; it applies to both transaction types and is added to the donation bonus (not compounded).
- Orders are stored in MySQL. A verified SePay webhook creates a row in the existing `nightmare_game_commands` queue with status `approved`; the Minecraft plugin claims, executes, and completes it through the existing queue.
- Card recharge remains separate.

## Render environment variables
Set these in the backend Render service Environment. Never put secrets in website JavaScript or commit them.

- `BANK_BIN`: VietQR bank BIN.
- `BANK_ACCOUNT`: receiving bank account number.
- `BANK_ACCOUNT_NAME`: account holder name as accepted by VietQR.
- `SEPAY_ACCOUNT_NUMBER`: same receiving account number reported in SePay webhook payload.
- `SEPAY_WEBHOOK_SECRET`: SePay HMAC-SHA256 webhook secret.
- `POINTS_PER_1000_VND=10`
- `PAYMENT_EVENT_BONUS_PERCENT=0` (set to e.g. `20` during an event; reset to `0` afterwards).

Payments stay disabled until all bank and SePay values above are configured.

## SePay webhook
Configure an HTTP POST webhook to `https://minecraftrechargebackend.onrender.com/webhooks/sepay`, with HMAC-SHA256 authentication and the same secret as `SEPAY_WEBHOOK_SECRET`. The backend checks `X-SePay-Timestamp`, `X-SePay-Signature`, inbound transfer type, destination account, unique transaction ID, exact amount, and unique order content.

## Verify after deployment
1. `GET /api/payments/config` should return `enabled: true` only after environment variables are complete.
2. Create a small test order while logged into the website.
3. Confirm the QR amount and transfer content match the order.
4. Make a real low-value test transfer only after checking the receiving account and webhook in SePay.
5. Confirm the order moves from `pending` to `paid`, then `fulfilled` after the Minecraft plugin processes the command.

Do not manually mark orders paid or award points based on screenshots/receipts. If the plugin cannot safely process a command, reconcile it manually before retrying to avoid duplicate credits.
