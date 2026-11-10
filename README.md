# Private two-person chat

A real-time chat website for exactly two people, with a Telegram/Instagram-style look.
No dependencies, just Node.js 18+.

## Run it

```bash
cd two-chat
node server.js          # or: npm start
```

Open http://localhost:3000. The terminal also prints a "same Wi-Fi" address you can open from a phone.

## How to use

1. Person 1 opens the site, enters a **name**, a **room name** and a **password**. This creates the room.
2. Person 2 opens the site and enters their own name plus the **same room name and password**.
3. Chat. A third person can't get in, because the room is full.

Signing in again later with the same name and password works from any device.

## Features

- Instant delivery (Server-Sent Events), no page refresh
- Online / last seen, "typing…", sent ✓ and seen ✓✓ ticks
- Messages saved on the server, so history survives restarts
- Links become clickable, Shift+Enter for new line (on phones, Enter is a new line and the arrow sends)
- Unread count in the tab title, optional desktop notifications
- Light and dark mode follow your device
- Works on phones, with an installable-looking full-screen layout

## Letting the other person reach it

`localhost` only works on your own computer. Options:

| Situation | What to do |
|---|---|
| Same Wi-Fi | Share the `http://192.168.x.x:3000` address that the server prints |
| Different places, quick test | Run a tunnel, e.g. `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000` |
| Permanent | Deploy to any Node host (Render, Railway, Fly.io, a VPS). Start command: `npm start`. **Attach a persistent disk/volume** and set `DATA_FILE=/that/disk/data.json`, otherwise history is lost on redeploy |

Always use **HTTPS** when it's on the internet (tunnels and hosts above give you that automatically). Without it, passwords and messages travel unencrypted.

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `DATA_FILE` | `./data.json` | Where chats are stored |

## Privacy and security notes

- Room passwords are stored hashed (scrypt); sign-in tokens are stored only as hashes.
- 8 wrong passwords from one address locks it out for 10 minutes.
- Messages are **not** end-to-end encrypted. They're stored as readable text in `data.json` on your server, so whoever runs the server can read them. Keep that file private.
- To delete a chat completely: stop the server and delete `data.json` (or just the room's entry).

## Files

```
server.js          Backend (HTTP, realtime stream, storage)
public/index.html  Page structure
public/style.css   Look and layout
public/app.js      Browser logic
```

## Ideas for later

Photo/file sharing, emoji reactions, reply-to-message, delete/edit messages, push notifications when the tab is closed, voice/video calls (WebRTC), true end-to-end encryption.
