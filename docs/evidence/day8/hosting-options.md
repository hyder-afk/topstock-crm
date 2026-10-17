# Hosting options for production (research of 16 Oct 2026)

Why: Vercel's fair-use guidelines limit the Hobby plan to non-commercial, personal use, and TopStock's own sales CRM is
commercial use (go-live decision 4). Haider decided on 16 Oct 2026: **"Stay on vercel for now"**. Production stays on
Vercel Hobby and he accepts the fair-use risk: Vercel may ask for an upgrade or pause the project. No data would be
lost, because the data lives in Supabase. This page keeps the comparison for the day a move is needed.

Figures marked * came from search summaries, not from the live official page: **(to re-check on the live page before
any move)**. Read first-hand, so unmarked: the Vercel fair-use text (Vercel's documentation, through Context7), the
CPU times measured locally, and the Cloudflare adapter test (run here on 16 Oct 2026). Everything else is marked.
Prices exclude VAT unless stated.

| Option | Cost | Fits us? | Main catch |
|---|---|---|---|
| **Vercel Hobby** (today) | €0 | Works today | Non-commercial only. The fair-use guidelines (https://vercel.com/docs/limits/fair-use-guidelines, "Commercial usage") say Hobby teams are restricted to non-commercial personal use, and count as commercial any deployment used for the financial gain of anyone involved in any part of its production. Pro at $20 a month was declined by Haider (16 Oct 2026) |
| **Cloudflare Workers Free** | €0 | No | No non-commercial clause found*, but a request gets 10 ms of CPU*. Server-rendered pages need more: measured locally, /login about 40 ms and /s/en about 33 ms |
| **Cloudflare Workers Paid** | about $5 a month plus VAT*; 10M requests and 30M CPU-ms included* | Yes (tested, see below) | A small adapter change set; the adapter's Node proxy support is marked experimental |
| **Netlify Free** | €0 | Unclear | 300 credits a month with a hard cap*: the site pauses when they run out*; about 15 credits per production deploy*; Next.js proxy on the Node runtime not verified |
| **Render Free** | €0 | No | Render says it is "not for production"*; the service sleeps after 15 minutes idle* and takes about 1 minute to wake* |
| **Fly.io** | about $3.2 a month* | Possible | No free plan* |
| **Railway** | free tier | Probably not | The free tier is likely non-commercial* |
| **Google Cloud Run** | probably €0 (the free allowance* should cover three users; europe-west9 is Tier 1*) | Possible | Needs a payment card with no hard spending cap*; cold starts of 2 to 4 seconds (estimate, not measured); the most setup of all |
| **Hetzner CX23** | about €6 a month* | Possible | A server Haider would run himself (updates, TLS, restarts) |

## Cloudflare Workers Paid: what was tested

- `@opennextjs/cloudflare` 1.20.12 needs `next` 16.4.1 or later (the repo has 16.4.0).
- With `next` 16.4.1, the app was built and run in `wrangler dev`. These all worked: public pages, the proxy's
  redirects, 401 answers, the CSP nonce, the security headers, fonts, server actions and cookies.
- Not tested: signed-in pages.
- The adapter documents Node proxy (middleware) support as experimental.
- Repo changes a move would need: `wrangler.jsonc`, `open-next.config.ts`, the rate limiter keyed on
  `cf-connecting-ip` instead of Vercel's header, and Workers Builds for previews.

## Recommendation (as given to Haider)

- If a move is ever needed: **Cloudflare Workers Paid** (about $5 a month*), planned by Claude as its own step.
- If it must cost €0: **Google Cloud Run**, accepting the card without a hard cap, the cold starts and the setup.

## Side note

Moving `next` from 16.4.0 to 16.4.1 is worth its own PR anyway, whatever the hosting, so the adapter's minimum is
already met if a move comes.
