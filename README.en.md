# marust — simulcast control app for OBS

> **The user interface is in Japanese only.** This page is a short English overview. Screens, buttons and messages are Japanese; an English UI is not planned. The detailed guide ([docs/GUIDE.md](docs/GUIDE.md)) is also Japanese. The main README is [README.md](README.md) (Japanese).

marust ("maru-suto") is a Windows desktop app that makes it easier for streamers in Japan to **stream from OBS to several sites at once** (YouTube, Niconico Live, Twitch and others); it starts, stops and monitors them from one screen. Japanese sites come first, overseas sites later; the major overseas sites (YouTube and Twitch stable, Kick and others experimental) are already covered. It does not send video itself: OBS sends the video, using a modified `obs-multi-rtmp` plugin that is distributed separately. marust controls the destinations, titles and categories around it. Stopping marust does not stop the stream.

## How to start
**Give this page (or [AI-GUIDE.md](AI-GUIDE.md), written for AI assistants) to any AI chat assistant and ask "how do I get started?"** It guides you step by step (installing the modified OBS plugin, the OBS WebSocket settings, where to find stream keys). Never paste stream keys, passwords or tokens into the AI; type them into marust's own fields. In the app: Help → "AI に案内してもらう".

## Three levels
Switch with View → level. It never changes by itself.
| Level | Meaning | What you get |
| :--- | :--- | :--- |
| Basic (初級) | Stream to several sites at once | add sites, start/stop, upload-bandwidth estimate |
| Intermediate (中級) | Manage them together | per-site login, one title/category to all sites, chat sending, automatic broadcast creation, add-on features |
| Advanced (上級) | Build and improve | install, write and improve plugins |

## What it does
- A home screen with one button per site (status and that site's settings), "start all" and "stop all", and "+" to add a site.
- Sends one title and category to every site you are logged in to (intermediate level and up). Some sites need you to create your own developer app (client ID and secret) to log in.
- Shows whether your upload bandwidth is enough for the number of destinations (you type in your upload speed; marust never contacts a speed-test server on its own).
- Optional automatic broadcast creation for YouTube and Niconico Live.
- Optional features you switch on later; in the advanced level you can install, or write, your own plugins (at your own risk). Handy extras will be collected in a community plugin list (in preparation).

## What it does not do
- Receiving chat is not marust's job. For now, please use [OneComme](https://onecomme.com/). In the advanced level you can connect OneComme through an extension or write your own receiver. marust only *sends* titles, categories and comments.
- It does not store your stream keys: keys are handed to OBS only.
- It does not install software (including the OBS plugin) on its own.
- No phone control or cloud re-streaming for now.

## Roadmap (not a promise)
More Japanese sites (OPENREC, Whowatch, SHOWROOM, 17LIVE, ...), then overseas (with translation tools).

## Install
1. Download the app zip from the Releases page and extract it. (From source: `npm install`, then `npm run start:app`; Node 18 or later.)
2. Install the modified OBS plugin yourself (a separate zip on the Releases page; it is not installed automatically). The in-app help describes how.
3. In OBS: Tools → WebSocket Server Settings → enable the server and set a password.
4. Start `marust.exe`. A first-run guide opens by itself (it can be reopened from the Help menu).

## Windows SmartScreen (unsigned build)
The build is **not code-signed**. The first time you run `marust.exe`, Windows may show "Windows protected your PC". Click "More info" → "Run anyway". You can also right-click the downloaded zip → Properties → tick "Unblock" before extracting. Download only from this project's Releases page. Help → "Check for updates" contacts the Releases page **only when you click it**.

## Where secrets are kept
Secrets defense has 3 rules: 1) stored only in an encrypted vault, 2) on screen only the last 4 characters are shown, 3) automatically redacted at any log or API output. Logins, tokens, stream keys and cookies go in an encrypted vault (Electron `safeStorage`, or Windows DPAPI) under `%APPDATA%\marust\`. Nothing secret is shown on screen or written to logs. The only way a secret value leaves the vault is the password-encrypted "move to another PC" file. Do not point `MARUST_STATE` at a shared or synced folder (OneDrive etc.). Deleting the app does not delete `%APPDATA%\marust\`; delete that folder to remove all logins and settings.

## Network
marust normally listens on `127.0.0.1:18770` only. While you log in to a site it temporarily opens a local redirect port on this PC.

## Plugins
Plugins you install from outside run with the **same power as marust itself**; there is no sandbox. Only install plugins you wrote or trust. See [docs/PLUGIN-API.md](docs/PLUGIN-API.md) (Japanese).

## Developers
`npm test`, `npm run check`, `npm run build`. Features are plugins under `plugins/` (`npm run new-plugin -- <id>` scaffolds one). The system consists of three units (the OBS plugin, the connector to the engine, and the core) structured across four layers (Core, Layer 1 Extension, Layer 2 Management, Layer 3 Improvement): see [docs/CORE.md](docs/CORE.md). Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). How releases are built: [docs/RELEASE.md](docs/RELEASE.md).

## License
See [LICENSE](LICENSE). The modified OBS plugin is a separate GPL-2.0 project, like the original.
