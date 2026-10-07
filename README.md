# Ladu Online — Premier League edition

Your Somali-rules Ludo, playable online with family anywhere. 2v2, club picker
(Arsenal · Liverpool · Man City · Man United), player accounts with win/loss
records on each device, and the computer fills any empty seat so a room of
2 or 3 people still works.

The server runs the exact same rules engine as the solo game — forced direct
kills, backward kills, locked stacks, bonus rolls, second hands, all of it —
and validates every move, so nobody's phone can cheat the dice.

## What's in the box

- `server/` — the game server (pure Node, **no dependencies** to install)
- `client/ladu-online.html` — the online game (served at `/`)
- `client/ladu.html` — the solo vs-computer game (served at `/solo`)
- `package.json` — start script for hosts like Render

## Play tonight on your home Wi-Fi (Mac mini)

1. Make sure Node is installed: open Terminal and run `node -v`.
   If it's missing, grab the LTS from https://nodejs.org and install it.
2. Unzip this folder on the Mac mini, open Terminal in the folder, run:
   `npm start`
   You should see: `Ladu online server listening on port 8471`
3. Find the Mac's local IP: Terminal → `ipconfig getifaddr en0`
   (looks like `192.168.1.42`). Leave the server running.
4. Everyone on the same Wi-Fi opens `http://192.168.1.42:8471` on their phone.
   Create a room, send the invite link the game gives you, sit down, play.

## Play over the internet (free, ~10 minutes, one time)

The server needs a public home. Render's free tier works:

1. Create a free account at https://github.com and a new **repository**.
2. Upload all of these files to the repo (keep the folder structure:
   `package.json` at the top, `server/` and `client/` folders as-is).
3. Create a free account at https://render.com → **New → Web Service** →
   connect your GitHub repo.
4. Settings: Runtime **Node**, Build Command: *(leave empty — no dependencies)*,
   Start Command: `npm start`. Pick the **Free** instance type. Create.
5. Render gives you a link like `https://ladu-online.onrender.com`.
   That's your permanent game link — send it to family, save it to your
   home screen.

Notes: free Render services sleep when idle, so the first open after a quiet
spell takes ~30–60 seconds to wake. Rooms live in the server's memory, so a
restart clears open rooms (records are safe — they live on each player's own
phone, in their account).

## How rooms work

- The host creates a room and gets a 4-letter code + invite link.
- Each player opens the link, signs in (or plays as guest), **sits in a seat**,
  and **picks a club**. Seats 1&3 are one team, 2&4 the other — partners sit
  across from each other.
- The host taps **Start**. Empty seats are played by the computer.
- If someone's phone dies mid-game, the host can open the Lobby tab and tap
  **🤖 Computer takes over** on their seat so the game never stalls.
- Anyone with the link who doesn't sit down just spectates.
