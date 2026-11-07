# Spike 002: Lichess explorer authentication and response

| | |
|---|---|
| Date | 2026-11-07 |
| Question | Q-1: does the explorer accept a personal token, what are the rate limits, and what does the response look like? |
| Answer | **A personal token with no permissions works.** Rate limits are not published in the response headers. |

## Results

- Anonymous `GET https://explorer.lichess.ovh/lichess?...` returns **401 Authorization Required**.
- With `Authorization: Bearer <personal token>` and **no permissions ticked**, it returns **200**. Three requests in a row took 0.36–0.45 s each.
- Response headers: `cache-control: max-age=86400` (Lichess suggests caching for a day). No rate-limit headers (`X-RateLimit-*` / `Retry-After`) appeared on success.

## Response shape (as received)

Query: `play=d2d4,g8f6,c1f4&speeds=blitz,rapid&ratings=1200,1400&moves=6&topGames=0&recentGames=0`

```json
{
  "white": 4919012, "draws": 375304, "black": 4680651,
  "moves": [
    { "uci": "g7g6", "san": "g6", "averageRating": 1434,
      "white": 1280978, "draws": 102494, "black": 1348187, "game": null, "opening": null }
  ],
  "recentGames": [], "topGames": [],
  "opening": { "eco": "A45", "name": "Indian Defense: Accelerated London System" }
}
```

What 1200–1400 blitz and rapid players play after 1.d4 Nf6 2.Bf4:

| Move | Share | White's score |
|---|---|---|
| g6 | 27.4% | 48.8% |
| d5 | 23.7% | 52.9% |
| e6 | 20.3% | 52.4% |
| d6 | 14.5% | 50.4% |
| c5 | 4.6% | 47.1% |
| Nc6 | 4.4% | 56.1% |

This is exactly the data the sparring bot needs. Under half of these opponents play the "book" 2...d5.

## Decisions

- Token: personal, **no permissions**, in `LICHESS_TOKEN`.
- The move field is `averageRating` (the server README shows `averageOpponentRating` for the player endpoint). The zod schema follows what we actually received.
- Cache entries in SQLite for **30 days**. That's longer than Lichess's one-day hint, but opening statistics barely move, and the long cache keeps our request rate near zero.
- Rate limits are undocumented here, so the client is conservative: **one request at a time**, and on a 429 it waits 60 s (or `Retry-After` if present) while that lookup counts as out of book.
