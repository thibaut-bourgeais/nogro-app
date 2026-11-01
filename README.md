# Nogro

Minimal workout log (PWA) with a copy-paste loop to an LLM coach.

- No build step, no dependencies: plain HTML/CSS/JS.
- Data stays in `localStorage` on the phone. Use *Profil & sauvegarde → Exporter* for backups.
- Coach loop: finish session → copy report → paste in Claude → paste reply back → *Importer*.

## Deploy (GitHub Pages)

```sh
git init && git add . && git commit -m "feat: initial workout log PWA"
git branch -M main
git remote add origin git@github.com:<user>/nogro-app.git
git push -u origin main
```

Then on GitHub: *Settings → Pages → Source: Deploy from a branch → main / (root)*.
App URL: `https://<user>.github.io/nogro-app/`. On Android Chrome: menu → *Installer l'application*.

The app repo must be **public**: GitHub Pages on a private repo needs a paid plan. It holds no personal data.

## Data sync (GitHub, private repo)

1. Create a second, **private** repo, e.g. `nogro-data` (empty is fine).
2. GitHub → Settings → Developer settings → Fine-grained tokens → Generate:
   repository access *Only select repositories* → `nogro-data`; permission *Contents: Read and write*.
3. In the app: *Profil & sauvegarde → Synchro GitHub*, fill owner / repo / token.

The app syncs `nogro-data.json` after each change, on start, and when back online.
Sessions merge as a union by id (deletions kept as tombstones); profile and plan come from the newer side.
The session in progress stays local. The token is stored on the phone, outside the backup export.

## Updating

Bump `CACHE` in `sw.js` on every deploy, otherwise phones keep the old cached version.

## Run locally

```sh
python3 -m http.server 8000
```
