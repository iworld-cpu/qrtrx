# ⬡ HiveDrop

**Free website** for same‑Wi‑Fi **chat + file share**.  
Open in browser → show **QR** → friends scan → message & transfer.  
**No app install.** Host for free on **GitHub Pages**.

## Features

- 🌐 Works as a normal website (GitHub Pages / any static host)
- 📷 QR join link (`?room=CODE`)
- 💬 Group chat in a room
- 📁 Drag‑and‑drop file transfer (peer‑to‑peer)
- 👥 Multi‑device (phone, PC, laptop) on the **same room**
- 🔒 Room codes isolate groups; data goes **WebRTC P2P** (LAN preferred)

> **How free hosting works:** the UI is static on GitHub Pages.  
> First connection uses free **PeerJS** cloud for signaling (needs internet once).  
> Chat & files travel **peer‑to‑peer** — on the same Wi‑Fi they usually stay local.

## Deploy on GitHub Pages (free)

### 1. Create repo

1. GitHub → **New repository** → name e.g. `hivedrop`
2. Public → Create

### 2. Upload files

Upload everything in this folder:

```
hivedrop/
  index.html
  css/style.css
  js/app.js
  manifest.webmanifest
  .nojekyll
  README.md
```

Or with git:

```bash
cd hivedrop
git init
git add .
git commit -m "HiveDrop initial"
git branch -M main
git remote add origin https://github.com/YOUR_USER/hivedrop.git
git push -u origin main
```

### 3. Enable Pages

1. Repo → **Settings** → **Pages**
2. Source: **Deploy from a branch**
3. Branch: `main` / folder `/ (root)` → Save
4. Wait 1–2 minutes

Your site:

```text
https://YOUR_USER.github.io/hivedrop/
```

### 4. Use it

1. Open the site on your PC  
2. Enter name → room code → **Enter hive**  
3. QR appears → others scan (same Wi‑Fi)  
4. Chat + send files  

## Local test (before GitHub)

Any static server:

```bash
cd hivedrop
npx --yes serve -l 5050
```

Open `http://localhost:5050`  
Phone on same Wi‑Fi: `http://YOUR_PC_IP:5050`

## How people join

| Role | Action |
|------|--------|
| Host | Opens website, creates room, shows QR |
| Others | Scan QR or open copied link — **no install** |
| Network | Prefer **same Wi‑Fi / LAN** |

Link shape:

```text
https://YOUR_USER.github.io/hivedrop/?room=ABC123
```

## Limits (honest)

| Topic | Detail |
|--------|--------|
| Internet | Needed to load site + PeerJS signaling |
| Offline LAN only | Use local QDrop server instead (`C:\Users\ADMIN\qdrop`) |
| File size | Soft cap ~200 MB per file (browser memory) |
| Host leaves | New room or someone re‑enters as host |

## HiveDrop vs QDrop

| | **HiveDrop** (this) | **QDrop** |
|--|---------------------|-----------|
| Hosting | GitHub Pages free website | Your PC Node server |
| Offline LAN | Needs internet for signal | Fully local |
| Install on others | No | No |
| Chat | Yes | Text send only |
| Best for | Share one public link + QR | Max privacy, no cloud |

## License

MIT
