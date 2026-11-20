# #BRO Transport Corp. — Dual-Portal Transborder Logistics OS

**Bold. Reliable. Orchestrated.** — *"A Bro in Need Is a Bro Indeed."*

Full-stack North American commercial cross-border freight platform (**Dry Van · Cold-Chain Reefer · Open-Deck Flatbed**) built on **Astro 5 + React 19 + Tailwind CSS v4 + Three.js + Hono + Drizzle ORM + Cloudflare Workers (D1, R2, KV, Durable Objects, Workflows, Workers AI, Cron)**.

---

## Dual-Portal Architecture

### Portal 1 — Public & External Partner Portal (`/` · `/portal/*`)
- **3D Geospatial Command Globe (`/`)**: GPU-instanced vector Natural Earth borders (<1 MB VRAM, <12 draw calls), real-time UTC Solar Day/Night Terminator, Fresnel atmosphere shader, throttled raycasting, and live color-coded **CBP & CBSA Border Wait Times**.
- **Geography-Aware Instant Rate Engine (`/quote`)**: OSRM highway routing (with `1.22×` Haversine fallback), integer-cent linehaul/FSC/customs/accessorial math, and EPA SmartWay $\text{CO}_2\text{e}$ carbon estimates.
- **Public Cryptographic eBOL Verifier & Tamper Lab (`/verify`, `/verify/[ebolId]`)**: Real browser-native Web Crypto `ECDSA P-256` + SHA-256 hash chain verification with an interactive 1-byte tamper attack demonstration and PDF certificate download.
- **Carrier Onboarding (`/apply`)**: Live **US DOT FMCSA QCMobile** authority & double-brokering capacity audit + border dead-zone offline Hashcash PoW queue.
- **Customer / Shipper Portal (`/portal/shipper`)**: Tenant-isolated shipment tracking, FSMA cold-chain temperature audit logs, 1-click quote booking, document vault, and PDF invoice downloads.
- **Driver Mobile-First Offline PWA (`/portal/driver`)**: Active trip sheet + stop geofence check-ins (emitting ANSI X12 `EDI 214`), 1-tap camera document scanner (BOL/POD/Lumper/Scale/Fuel/CDL/COI with WebP compression & offline IndexedDB queue), 12-point Digital DVIR (auto-locking critical defects `out_of_service`), ECDSA eBOL pickup signing, and Driver Settlement PDFs.

### Portal 2 — Internal Employee & Admin Command Tower (`/ops/*` — Strict RBAC)
- **Control Tower (`/ops`)**: Live KPI telemetry, `OpsHubDO` WebSocket broadcast feed, Priority Ally Escalations queue, and `DispatchCopilotAgent` natural-language command bar (`Cmd+K`).
- **Dispatch & Native EDI (`/ops/dispatch`)**: 11-state Load Lifecycle board, Out-Of-Service safety-locked equipment assignment, and deterministic ANSI X12 `EDI 204 / 990 / 214 / 210 / 997` engine.
- **AI Document OCR Verification Queue (`/ops/documents`)**: Powered by `DocumentProcessingWorkflow` (Cloudflare Workflows + Workers AI Vision OCR + durable `waitForEvent` HITL approval pauses) with side-by-side R2 document viewer and confidence gating.
- **Cross-Border Customs & CARM Desk (`/ops/customs`)**: 2026-compliant CBP ACE PAPS & CBSA ACI PARS builder enforcing ISO 3779 VIN check digits, **CBSA CARM Release 2 IOR RPP readiness**, **FDA 2-Hour Prior Notice**, scannable **ISO/IEC 15417 Code-128B Cover Sheet PDFs**, and timing-safe HMAC-SHA256 RNS webhooks.
- **Billing, Factoring, Settlements & IFTA (`/ops/billing`)**: Automated `BillingSettlementWorkflow`, zero-rated cross-border tax vs. provincial GST/HST, 1-click merged **Factoring Packet PDFs**, AR aging, Driver Settlements (CPM & `%` Gross), and Quarterly IFTA Tax CSV export.
- **Fleet Safety & Weibull-Cox Digital Twin (`/ops/fleet`)**: Equipment registry, mechanic DVIR clearance, 30-day compliance expiry watchdog, and mathematically bounded **Weibull-Cox Proportional Hazards** survival & RUL diagnostics.
- **Admin & Autonomous Agent Governance (`/ops/admin`)**: Super-admin RBAC management, immutable audit trail, and live controls for `CustomsPreFlightAgent`, `FleetWatchdogAgent`, `DispatchCopilotAgent`, and Cloudflare Workflows.

---

## Monorepo Structure

```text
packages/contracts/   # Single source of truth: Zod v4 schemas + pure domain engines
packages/db/          # 22-table Cloudflare D1 Drizzle ORM schema, migrations & seed
workers/              # Hono Edge API, Durable Objects, Workflows, Cron & Services
src/                  # Astro 5 full-stack app, React 19 islands, Three.js Globe & Portals
```

## Quick Start (Local Development)

```bash
pnpm install
cp .env.example .dev.vars
pnpm run db:migrate:local
pnpm run typecheck
pnpm run test
pnpm run dev
```

## Production Deployment (Cloudflare Workers)

1. Provision D1 (`brotransport-db`), R2 (`brotransport-vault-r2`), and KV (`CACHE`) in Cloudflare Dashboard and set their IDs in `wrangler.jsonc`.
2. Push required secrets via `wrangler secret put <NAME>` (see `.env.example`).
3. Run `pnpm run db:migrate:remote && pnpm run deploy` (or push to `main` for automated GitHub Actions verification & deploy).