# Workspace Customization Rules

## Issue Completion and Closing Process
Whenever the implementation of a specific issue is finished:
1. Ask the user if they consider the issue complete.
2. If the user confirms (says "yes" or similar), close the corresponding issue on GitHub.
3. Write a highly detailed closing comment for the closed issue that lists all specific modifications made to the website/codebase. The description should not be brief—it must document:
   - What components were added, modified, or deleted.
   - Any visual changes, layout modifications, color token updates, or copywriting updates (e.g., logos updated, text sections rewritten, new navigation tabs added).
   - Verification and manual testing summaries.
4. After closing the issue, push the code changes to the remote `dev` branch and then merge the `dev` branch into the `main` branch.

---

# #BRO TRANSPORT — IRONCLAD ENGINEERING CONSTITUTION (FLASH 3.1 LOW LOCK)

Follow these 12 NON-NEGOTIABLE LAWS on EVERY turn:

1. **ZERO MOCKS / ZERO THEATER**: Never write `Math.random()` for hashes, IDs, fraud checks, pricing, or telemetry decisions. Never write `// TODO`, `// placeholder`, `includes('double brokering')`, or `alert()`/`confirm()`/`prompt()`. Use `crypto.randomUUID()` for IDs and `crypto.subtle` for all cryptographic hashing/HMAC/ECDSA.
2. **STRICT ZOD V4 ONLY**: The entire monorepo uses `zod@^4`. NEVER use Zod v3 APIs (`errorMap`, `required_error`, `err.errors`). ALWAYS use Zod v4 APIs (`error`, `result.error.issues`).
3. **SINGLE SOURCE OF TRUTH**: Every request/response DTO, enum, and validation schema MUST live in `packages/contracts` (`@bro/contracts`) and be imported by both frontend (`src/`) and backend (`workers/`). Never duplicate schemas.
4. **INTEGER CENTS FOR MONEY**: Store and calculate ALL monetary amounts in integer cents (`linehaulCents`, `totalCents`, `ratePerMileCents`). NEVER use floating-point dollars for accounting, billing, settlements, or tax math.
5. **VALID TAILWIND V4 SHADES ONLY**: Allowed Tailwind shades are ONLY `50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950` and custom tokens (`bro-obsidian`, `bro-steel`, `bro-cyan`, `bro-gold`, `bro-crimson`, `bro-ice`). NEVER invent shades like `slate-350`, `slate-450`, `slate-650`, or `rose-450`.
6. **SECURITY BY DEFAULT**: Fail closed when secrets are missing in production (never fall back to test keys). Never use `CORS: '*'`. Escape all user strings in HTML emails. Use UUIDs for all R2 object keys (never raw user input). Check RBAC role & org ownership on every `/api/*` route.
7. **ASTRO CLIENTROUTER LIFECYCLE SAFETY**: Never query DOM elements once at module top-level inside `.astro` `<script>` tags. Always initialize inside `astro:page-load` and tear down listeners, `requestAnimationFrame`, WebGPU/WebGL renderers, and WebSockets inside `astro:before-swap` (or React `useEffect` return).
8. **ACCESSIBILITY & MOTION SAFETY**: Every interactive modal/drawer must support `Escape`, focus management, and ARIA dialog roles. Honor `prefers-reduced-motion: reduce`. Never add flashing/strobing/glitching animations.
9. **DETERMINISTIC VS AI BOUNDARY**: Workers AI / Vision LLMs ONLY extract unstructured text/JSON from documents or draft text. Deterministic TypeScript functions ALWAYS compute prices, taxes, VIN check digits, IFTA totals, invoice math, and compliance pass/fail.
10. **COMMERCIAL FREIGHT IDENTITY LOCK**: Military/Superload concepts (`cgpAuthorized`, `militaryCleared`, `multi-axle` remappings) are permanently retired. Core equipment divisions are strictly Commercial **Dry Van (`dry_van`)**, **Reefer (`reefer`)**, and **Flatbed (`flatbed`)**.
11. **MANDATORY VERIFICATION GATE**: Before declaring any phase complete, run `pnpm typecheck && pnpm test && pnpm build` and verify exit code `0`.
12. **STATE HANDOFF**: Keep `BUILD_STATE.md` updated at every completed milestone.
