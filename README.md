# Kummerkasten

Anonymer Kummerkasten und Retro-Check für die Kurs-Retro. Cloudflare Worker + D1.

- `src/index.html` – die App (Rückmeldung, Retro-Check, Pinnwand, Retro-Modus)
- `src/worker.js` – Server (API, Datenbank, Retro-Passwort)
- `wrangler.toml` – Cloudflare-Konfiguration (D1 `kummerkasten-db`)

Die Tabellen legt der Worker beim ersten Aufruf selbst an.
Änderungen committen und pushen, Cloudflare veröffentlicht automatisch.
