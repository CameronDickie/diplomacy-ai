# Harness changes between full games

What changed in the model-only full-game harness ([autoplay](autoplay.md))
between the live games, in the order the games were played. Written for the
blog post: each game's results should be read against the harness it was
played under. Records from game 4 on carry the exact commit and an
instructions fingerprint in `run.harness`; every record carries its
`run.contextVersion`. Only full games are affected; the daily challenge keeps
its own pinned instructions throughout.

| Version | Games | Context | Instructions fingerprint |
| -- | -- | -- | -- |
| 1 | 1, 2 | `luna-context-v4` | not stamped |
| 2 | 3 | `luna-context-v5` | not stamped |
| 3 | 4 | `luna-context-v5` | `09a9e11232f3ae2c` |
| 4 | 5 | `luna-context-v5` | `09a9e11232f3ae2c` |
| 5 | 6 to 9 | `luna-context-v6` | `6885cbe55074ee51` |
| 6 | 10 | `luna-context-v7` | `eea263560b16613d` |
| 7 | from 11 | `luna-context-v8` | `8434bf6012a2b346` |

## Version 1: games 1 and 2

The starting point. Every power sees the public board and last turn's
results, its own messages with other powers (the newest, up to 6,000 bytes:
about the last year), and a numbered list of its legal orders. Before orders,
each power may write to up to three others and each power written to replies
once.

Changed during game 1 and before game 2, all about getting usable answers
rather than about strategy:

- Orders answered unit by unit (`{"unit":"PAR","choice":12}`) instead of a
  bare list of numbers, after GPT-6 Luna repeatedly gave one unit two orders
  and another none.
- A rejected answer is retried with the reason it was rejected.

## Version 2: game 3 (seats swapped)

- The build rule says outright "N free home centers but only M builds".
- Each request states the standings: every power's supply-center count, and
  how far the leader is from 18.
- Moves two of a power's own units could both make are marked "shared with".
- A support or convoy of another power's unit names whose unit it is.

## Version 3: game 4

- **The hold rule reworded.** Version 1 said to hold a unit "only when it sits
  on one of your supply centers that another power could reach this turn". It
  now says holding is the exception, a rival next door is not by itself a
  reason to hold, and a center is only lost if a rival stands on it at the end
  of a Fall turn.
- Calls may take 40 seconds instead of 20; a game run "until a win" ends as a
  stalemate after 10 years with no center changing hands (it never did).
- Two transport fixes during the game (clearer failure reasons; a fresh
  connection per call). Neither changes what a model sees.

Result: Claude Haiku 5.5 held 82% of its orders, against about 84% before. The
wording was not the cause.

## Version 4: game 5 (seats swapped)

- When a power's own moves block each other (two units sent to one place, or a
  unit into a place its own unit is not leaving), the model is told which
  units clash and asked once more. Its second answer is played as given. In
  game 4, Luna did this in half of its turns once a power had 14 or more units.

## Version 5: games 6 to 9

- **Only a solo win counts.** The orders and message instructions say that
  ending the game without 18 supply centers is a loss, the same as being
  eliminated. Haiku has held 82–85% of its orders in every game, whatever its
  countries; this tests whether it is playing to survive.
- **Convoys explained.** One instruction line: armies cross water only by
  convoy, a fleet at sea orders the convoy and the army the move in the same
  turn, and a fleet in a coastal province cannot convoy.
- **Convoys paired in the list.** An army's move by convoy says which of its
  fleets must convoy it ("arrives only if F NTH also convoys it there this
  turn"), and a fleet's convoy says which army move it needs.
- **Convoys planned a turn ahead.** Before the list, each army on a coast gets
  up to two lines naming a fleet move this turn that would let it be convoyed
  next turn, and where to. In game 4 England had an army at home in 198 turns,
  but a fleet at sea beside it in only 75, and made 2 convoy orders all game.
- **Convoys missing their other half** (an army sent by convoy that none of its
  fleets convoys, or a fleet convoying its own army that is not moving there)
  are asked about once, like self-blocking moves.

The incentive and the convoy help are measured separately: hold rate for the
first, convoy orders for the second. They could still interact.

Result (games 6 and 7, both to 1950): Haiku held 72% (default seats) and 77%
(swapped), against 82–84% for the same seats before. Haiku powers led for long
stretches for the first time (Russia in game 6, Austria in game 7). Convoys:
in game 6 England (Haiku) had a fleet at sea beside a waiting army in 88% of
such turns, against 33% in game 4, and made 10 convoy orders instead of 2; in
game 7 the hints were mostly unused, and Haiku's Italy made one convoy move.

Games 8 and 9 used the same harness with one model on every seat, as
baselines. All Haiku: 82% holds, 3 lead changes, no convoys. All Luna: 15%
holds, 14 lead changes, 24 armies moved by convoy (7 arrived), and a power with
14 or more units still sent two units to one place in 38% of its turns after
the ask-once check.

## Version 6: game 10

Two unrelated fixes, measured on different numbers.

- **Centers about to change hands.** In games 4, 6, 7 and 9, when a Luna unit
  stood on a center its power did not own yet at the start of a Fall turn, it
  moved off in 40–61% of cases, giving up the center it had walked into in
  Spring. Now, in a Fall turn:
  - every request says which centers change hands if the units now on them
    stay (the text version of the map's stripes);
  - a power's request lists the centers it is about to take, and each order of
    such a unit says "staying takes BUL after this Fall" or "leaving gives up
    BUL";
  - one instruction line: a unit takes a center only by still being there when
    the Fall turn ends.
- **Clash warnings are never cut.** The "shared with" notes on moves two of a
  power's units could both make were the first thing cut from a long request,
  which is exactly when a power is large. Rebuilding game 9's requests from
  powers with 10 or more units showed the notes cut in 34 of 89, and those
  turns clashed 26% of the time against 4% with the notes. In full games the
  notes are now kept; message history, recent results, convoy plans and long
  option lists give way first, and the notes go only if nothing else fits
  (it did not happen when game 9 and game 4 were rebuilt). The cost: about one
  large-power request in five now has its message history or option list
  shortened, against one in fifteen before.

Result (game 10, all Luna, to 1950): units standing on a center not yet owned
at the start of Fall moved off it 2% of the time, against 44% in game 9. The
public line also drove the other powers to stop a solo: England reached 17,
and in Fall 1947 Austria, Italy and Turkey coordinated against the army whose
center would have won it, taking seven of England's centers in one turn.
Clashes: 3% of turns for powers with 10–13 units (game 9: 4%); only 8 turns
with 14 or more units, too few to compare.

## Version 7: from game 11

Memory. Until now a power saw only its newest messages across all partners,
cut at 6,000 bytes: about the last year. Nobody could hold anyone to a promise
made a decade earlier, and in the all-Haiku game Germany paced a fleet back and
forth across the Baltic for decades, like a player with no plan it could
remember.

- **Whole threads.** When a power writes to others or answers them, it now sees
  its conversation with each of those powers as a separate thread, oldest
  first. The threads share 12,000 bytes; a thread longer than its share keeps
  its newest messages. Orders requests keep the previous single list of recent
  messages.
- **A private notebook.** With its orders, each power writes itself a note of
  at most 300 characters (its plan, promises made and received, who kept
  theirs). Its own notes from earlier turns, the newest within 2,000 bytes
  (about the last six), are shown in every later request it gets: orders,
  messages and replies. Nobody else sees them. The notes are in the game record
  and in the viewer, beside each power's orders.

What to measure: how often messages refer back to earlier turns, whether
powers keep what they promised, and whether a power's moves follow the plan in
its notes.

Result (game 11, all Luna): Austria won in Fall 1941, the first solo win since
game 3. Every power wrote notes (434, averaging 227 characters): concrete
plans, promises made and broken (including its own), and standing distrust.
Messages referring back to earlier turns rose only from 3% to 4%; the memory
shows in the notes more than in the talk. The game also found a harness bug:
a win counted after Fall retreats left the game in a retreats phase with
nobody retreating, so every recovery failed. Fixed in PR #77; the game was
finished from its saved decisions with no new model calls.

Result (game 12, all Haiku): no winner, and Haiku became more static than in
game 8 (version 5): 87% holds against 82%, half as many successful moves, and
49% of moves reversed the next turn (39% in game 8). Haiku's notes are a ledger
of non-aggression pacts ("all hold… Pacts: France (…), Russia (…)"); 97% use
defensive words, 40% mention attacking (Luna in game 11: 86%). Whole threads
made Haiku's message requests much longer (up to 8,000 tokens), and the game
cost USD 1.97 against 1.34. Three things changed since game 8 (capture
notices, kept clash warnings, memory), so this is not memory alone.

## Reasoning effort (an option, from game 13)

Every game so far ran both models at their lowest reasoning effort, the
setting the challenge pins. `--effort medium` or `high` now sends every request
of a full game at that effort, with a larger output ceiling (reasoning counts
toward it: GPT-6 Luna 2,048 → 8,192 / 16,384 tokens, Claude Haiku 5.5 4,096 →
8,192 / 16,384), a matching worst-case reservation per call, and longer time
limits. The instructions and context are unchanged (fingerprint
`8434bf6012a2b346`); the record states the effort in `run.harness.effort`, and
a game cannot be continued at a different effort.

Result (game 13, all Haiku with memory, medium effort): reasoning tokens per
call doubled (263 → 574), holds stayed at 87%, successful moves fell to 133
(210 in game 12), and fewer moves were reversed the next turn (32% against
49%). Supports rose slightly (5% → 7%). Cost USD 2.45 against 1.97.

Result (game 14, all Luna with memory, medium effort): Russia won in 1921,
the earliest win in any game. Reasoning tokens per call rose about fourfold
(380 → 1,565). Large powers (14+ units) clashed in 5% of turns (game 11: 30%;
games 9–10: 38–50%); self-blocking refusals fell from 15 to 2; supports rose
to 30% of orders (21%); 7 of 13 convoys arrived; holds stayed low (19%).
England was eliminated for the first time in any game. Cost USD 1.19, the same
as game 11 for half the years.

## Stronger models (an option, from game 15)

GPT Sol 6.1 (`gpt-6.1-sol`) and Claude Sonnet 5.5 (`claude-sonnet-5-5`) can now
play any power, as each provider's stronger counterpart to Luna and Haiku. Their
requests are byte for byte the same as the smaller model's of the same
provider apart from the model name, so instructions and context are unchanged
(fingerprint `8434bf6012a2b346`). Prices, as given by the owner on 2026-10-17,
in USD per million tokens: Sol input 2.00, cached input 0.10, cache writes 2.50,
output 10.00; Sonnet input 2, output 10, cache write 2.50, cache read 0.10. Two
figures were not given and are assumptions, and neither can apply to these
requests: Sonnet's one-hour cache write (set at twice input, $4, which only
sizes the worst-case reservation, since no request writes a cache) and Sol's
long-context output rate (1.5×, a threshold the input bound keeps requests far
below). Both are twenty times Luna's and Haiku's prices.

## Not yet changed

- **Draws.** Letting powers propose a draw that every survivor must accept
  (DIC-93).
