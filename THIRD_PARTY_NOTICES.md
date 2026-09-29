# Third-Party Notices

## Godip

The standard Diplomacy adjudication engine and the province-ID SVG map are from
[zond/godip](https://github.com/zond/godip), pinned to version `v0.6.5`.

- Copyright: Godip contributors
- License: GNU General Public License v3.0
- Upstream source: https://github.com/zond/godip/tree/v0.6.5
- Local license copy: [engine/GODIP_LICENSE](engine/GODIP_LICENSE)
- Map source:
  `variants/classical/svg/map.svg` at tag `v0.6.5`

The browser serves an unmodified copy of that upstream SVG as
`client/public/standard-map.svg`. The Go wrapper source and build instructions
are in `engine/`; `engine/go.mod` and `engine/go.sum` identify the pinned Godip
source used to build the executable. `shared/src/constants/adjacency.generated.ts`
is generated from Godip's classical board graph by `npm run generate:board`.
The process boundary is an architectural choice and does not limit any GPL
obligations.

## Libre Baskerville

The upstream Godip SVG embeds Libre Baskerville font data. The font is
copyright 2012 The Libre Baskerville Project Authors, with Reserved Font Name
Libre Baskerville, and is licensed under the SIL Open Font License 1.1.

- Font source: https://github.com/impallari/Libre-Baskerville
- Local license and copyright notice: [LIBRE_BASKERVILLE_OFL.txt](LIBRE_BASKERVILLE_OFL.txt)

The browser-accessible notices and license texts are linked from the game's
[credits and licenses page](client/public/legal.html). The production image also
contains these notices, the application source, and the pinned Godip source.
