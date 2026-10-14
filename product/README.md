# yld.cx

Provide liquidity, rent or swap tokens, and manage your orders.

Use Node.js 24+. Run commands from `product/`.

## Development

```sh
npm ci
cp .env.example .env.local
npm run dev
```

## Production

```sh
npm run build
npm start
```

## Checks

```sh
npm run check
npm exec playwright install chromium
npm run test:browser
PLAYWRIGHT_SERVER=development npm run test:browser
```
