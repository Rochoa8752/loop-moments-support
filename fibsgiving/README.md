# Fibsgiving 🦃

A draw-and-bluff family party game played on everyone's phone, whether they're at the table or far away.

## Rounds
1. **Fib Frames**: draw a secret silly prompt. Everyone else writes fake titles, then everyone hunts for the real one.
2. **Family Portraits**: same idea, but every prompt stars someone who's playing.
3. **Frankenfeast**: three artists draw the head, body and legs of a creature, each seeing only a sliver of the part above. Then everyone names it.
4. **The Thankful Wall**: everyone writes a note, and the notes are read together on every screen.

Extras: Guest of Honor 👑 (their hearts count triple), live emoji reactions, pace setting (Speedy / Normal / Relaxed), automatic host failover, and a **Keepsake Gallery** (`?gallery=CODE`) with every drawing from the night.

## Running it
It's a static site with no build step. Serve this folder from any static host (Netlify, GitHub Pages, etc.).
The backend is the `fibsgiving` Supabase project (tables `rooms` and `moves`, plus Realtime). The public anon key in `app.js` is safe to ship; row-level security is deliberately open, since anyone with a room code can play.

Edit prompts in `decks.js` and add inside jokes!
