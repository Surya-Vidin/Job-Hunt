# Regent — one search for every job board

## Run
```bash
npm install
cp .env.example .env   # add Adzuna keys
npm start              # http://localhost:3000   (Node 18+)
```

## External services
| Source | Key? | Notes |
|---|---|---|
| Adzuna API | Free key (developer.adzuna.com) | Main source: location radius, salary filter, ~19 countries incl. India. Show "Jobs by Adzuna" attribution per their ToS. |
| Remotive API | None | Remote jobs only. Their ToS require linking back to the job URL (done) and not hammering the API (15‑min cache). |
| Arbeitnow API | None | Mostly Europe. |
| LinkedIn / Indeed | — | No public job-search API and scraping violates their ToS. The app deep-links to prefilled LinkedIn and Indeed searches instead. Official partner programs (Indeed Publisher/Partner, LinkedIn Talent) are paid/approval-based; add a new adapter in `sources` in `server.js` if you obtain access. |
| Others (Jooble, The Muse, USAJobs) | Free keys | Add one adapter function each returning `mk({...})`. |

## How features work
1. **Search** — `q` is sent to every adapter in parallel (`Promise.allSettled`, so one failing source never breaks results), then merged, de-duplicated and sorted by date. Matches title, company and description text.
2. **Location** — country (Adzuna country code), state, city, radius. Adzuna filters by radius server-side. Other sources have no coordinates, so they are filtered by city/state text match; remote roles always pass.
3. **Salary** — passed to Adzuna; applied to any job with numeric pay. Jobs with no listed pay stay visible.
4. **Experience** — no source offers a structured field, so years are inferred from posting text ("3+ years") and title (junior/senior). Unknown stays visible.
5. **Résumé** — PDF (pdf-parse), DOCX (mammoth) or TXT is parsed in memory (never saved). The server extracts skills (dictionary match), years of experience and likely role, searches with that, and ranks jobs by skill overlap, title match and experience fit.
6. **Apply** — every card has "Apply on <source>" opening the original posting in a new tab, plus "Email employer" (prefilled mailto) when applicable.

## Contact details policy
Emails and `+` international phone numbers are shown only if they literally appear in the posting text supplied by the job source, labelled "Listed by the employer". Nothing is scraped, guessed or looked up elsewhere. Otherwise the card says none is listed.

## Layout
`server.js` — Express API, source adapters, SQLite cache (`jobs.db`), résumé parser. `public/index.html` — UI (vanilla JS, no build step).

## Limits / next steps
Postings are cached for 15 minutes; pagination, accounts/saved jobs, and a geocoder (e.g. Nominatim) for radius on non-Adzuna sources are not included.
