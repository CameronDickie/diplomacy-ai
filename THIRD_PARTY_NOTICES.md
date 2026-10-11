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

## ObsidianUI

The challenge interface's arrow-fill button (`ArrowFillButton` in
`client/src/challenge/Shell.tsx`, styles in `client/src/challenge/theme.css`)
adapts ObsidianUI's Arrow Fill Button, by way of the same adaptation on
camerondickie.ca. It has been adapted to a native button, this site's theme
variables and reduced-motion support.

- Project: https://www.obsidianui.dev/
- Arrow Fill Button: https://www.obsidianui.dev/docs/arrow-fill-button
- Original license: https://gitlab.com/Atharvsinh-codez/ObsidianUI/-/raw/main/LICENSE

```text
MIT License

Copyright (c) 2026 ObsidianUI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Source Sans 3

The challenge interface uses the Source Sans 3 typeface, served from
`client/public/fonts/source-sans-3-latin.woff2` (Latin subset). Copyright
2010-2020 Adobe, with Reserved Font Name 'Source'. It is licensed under the SIL
Open Font License 1.1; the text is in `client/public/SOURCE_SANS_3_OFL.txt` and
is served at `/SOURCE_SANS_3_OFL.txt`.
