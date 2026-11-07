# Chess Tutor

[![CI](https://github.com/daveharmswebdev/chess-tutor/actions/workflows/ci.yml/badge.svg)](https://github.com/daveharmswebdev/chess-tutor/actions/workflows/ci.yml)

A chess tutor for club players. You play against a sparring bot that leaves the opening book
the way real 1000-rated players do, and a Claude-powered tutor coaches you at the key
moments. Every concrete chess claim comes from the Stockfish engine, which the tutor calls as a tool.

- **Progress:** the [Chess Tutor project board](https://github.com/users/daveharmswebdev/projects/5) and the [issues](https://github.com/daveharmswebdev/chess-tutor/issues)
- **Specs:** [requirements](docs/requirements.md) · [architecture](docs/architecture.md) · [how development is orchestrated](docs/orchestration.md)

## Run locally

Requires Node 22 and pnpm.

```bash
pnpm install
cp .env.example .env   # add ANTHROPIC_API_KEY and LICHESS_TOKEN
pnpm test
```

The playable app is not built yet: see the board.
