# Chess Analyzer

Paste a PGN and every move gets checked by **Stockfish 19**, running locally in your browser. The app then tells you where the game was decided, what the engine would have played instead, why your move was bad (the opponent's best reply), and what to work on.

## Why an engine and not a chatbot

Language models don't calculate chess. They pattern-match on text, so deep forcing sequences (the moves 25–35 where games are usually decided) are exactly where they go wrong. This app keeps the two jobs apart:

| Job | Done by | Trust level |
| --- | --- | --- |
| Evaluating positions and finding the best moves and lines | Stockfish 19 (WASM), MultiPV 3, configurable depth | Engine-verified |
| Classifying moves, accuracy, patterns, recommendations | Deterministic rules applied to the engine numbers (lichess win-chance model) | Derived only from engine output |
| *(Optional)* Written explanation in plain English | Claude, given **only** the engine's verified lines and told not to calculate | Every move it mentions is checked against the engine data, and unverified ones are flagged |

The engine analysis works fully offline once the page has loaded. The Claude review is optional and needs your own Anthropic API key.

## What you get

- **Every move classified**: best / excellent / good / inaccuracy / mistake / blunder / forced, using lichess's thresholds on lost winning chances.
- **Board with arrows**: green = the engine's best move instead, red = how the opponent punishes the move you played.
- **Clickable engine lines**: step through the best line, the refutation, and the alternative candidate moves on the board.
- **"Verify this decision deeper"**: re-run any critical position at depth 22+ to confirm the verdict.
- **Evaluation graph**, plus accuracy (lichess formula) and average centipawn loss for both players, per game phase.
- **Coaching report**:
  - **Turning point**: the move after which the game was lost and never recovered.
  - **Patterns**: hung pieces, allowed tactics, missed tactics, allowed or missed mates, positional errors, throwing away won positions, not punishing the opponent's mistakes, critical "only-move" positions, and time trouble (from `[%clk]` comments in Lichess or Chess.com PGNs).
  - **What to work on**, ranked, with a concrete drill and links to the moves behind each item.
  - **What went well**.
- **Multi-game PGN files**: pick which game to review.

## Running it

Requires Node.js 20+.

```bash
npm install        # also copies the Stockfish WASM files into public/engine
npm run dev        # open the printed URL
```

Paste a PGN (Lichess and Chess.com both offer "Download PGN" / "Copy PGN"), enter your username so the app knows which side you played, and click **Analyze game**. At depth 16 a 40-move game takes a couple of minutes on a typical laptop (a progress bar shows the time remaining). Use depth 20–24 for games you want to study closely.

### Stronger engine

The default build is Stockfish 19 *lite* (about 1.7 MB, still far stronger than any human). For the full-strength network (about 99 MB):

```bash
FULL_ENGINE=1 npm install
```

and choose "Stockfish 19 full" in the app.

### Command line

The same analysis pipeline runs in Node:

```bash
npm run analyze -- mygame.pgn --name yourusername --depth 18
npm run analyze -- games.pgn --game 3 --color b --json > review.json
```

### Deploying

`npm run build` produces a static site in `dist/` that can be hosted anywhere. A GitHub Actions workflow (`.github/workflows/deploy.yml`) publishes it to GitHub Pages on every push to `main`. Enable it under **Settings → Pages → Source: GitHub Actions**.

## Development

```bash
npm test            # unit tests + integration tests against the real Stockfish engine
npm run typecheck
npm run test:e2e    # Playwright: drives the built app in Chromium
```

Code layout:

- `src/engine/` — UCI client (`uci.ts`) with browser Web Worker and Node child-process transports
- `src/analysis/` — PGN parsing, per-position engine evaluation, move review and classification, coaching insights
- `src/coach/claude.ts` — optional Claude review: prompt built from engine facts, and post-hoc verification of the moves it mentions
- `src/ui/`, `src/main.ts` — the web UI (board by [chessground](https://github.com/lichess-org/chessground))

## How the numbers work

- **Winning chances**: `50 + 50 · (2 / (1 + e^(−0.00368208 · cp)) − 1)`, which is lichess's model. Mate scores count as 0% or 100%.
- **Move classification**: based on how many percentage points of winning chances the move lost compared with the engine's best move. The cut-offs are under 2 (excellent), under 5 (good), under 10 (inaccuracy), under 15 (mistake), and 15 or more (blunder). When the move you played was one of the engine's MultiPV candidates, it is scored from that same search, so equal-strength moves aren't penalised by depth noise.
- **Accuracy**: lichess's per-move formula, combined into a game score as the mean of a volatility-weighted average and a harmonic mean.
- Once a game is already lost, further errors barely change your winning chances. That is why the report finds the **turning point**: the moves before it are the ones worth studying.

## License

GPL-3.0-or-later, because the app bundles Stockfish and chessground, which are both GPLv3.
