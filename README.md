# Logbuch

Logbuch unserer Kurs-Retro: anonym Gedanken ins Segelboot werfen (Wind, Anker, Felsen, Insel),
danken, Aha-Momente teilen, abstimmen und festhalten, was wir verbessern. Cloudflare Worker + D1.

- `src/index.html` – die App (Rückmeldung, Retro-Check, Pinnwand, Verlauf, Retro-Modus)
- `src/worker.js` – Server (API, Datenbank, Retro-Passwort)
- `wrangler.toml` – Cloudflare-Konfiguration (D1 `kummerkasten-db`)

Anonym: keine Namen, keine IP-Adressen, keine Cookies. Das Retro-Passwort liegt verschlüsselt
als Variable `PASS_HASH` bei Cloudflare, nicht im Code.
