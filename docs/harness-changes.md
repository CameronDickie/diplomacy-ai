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
| 6 | from 10 | `luna-context-v7` | `eea263560b16613d` |

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

## Version 6: from game 10

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

## Not yet changed

- **Memory of conversations.** A power still sees only about the last year of
  its messages, across all partners. Options under consideration: show a
  power its whole thread with the power it is answering, or let each power keep
  a short private notebook of agreements.
