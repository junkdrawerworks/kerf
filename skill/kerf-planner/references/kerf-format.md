# Kerf project format

Use this when you can't run `scripts/make_kerf.py` and need to write a project by hand. The script produces exactly this.

Kerf reads a project as JSON: from a file (**Projects → Open a project file**), from the paste box under **Projects**, or from a link.

```json
{"kerf": 1, "project": {
  "name": "Mudroom bench",
  "units": "in",
  "kerf": 0.125, "trim": 0, "edge": 0, "keep": 12, "cur": "$",
  "notes": "Pocket screws: 16 × 2½″ for the frame.\nFinish: two coats of wipe-on poly.",
  "materials": [
    {"kind": "board", "name": "2×4", "note": "1½ × 3½ in",
     "stock": [{"len": 96, "price": 4.28, "have": 0}, {"len": 120, "price": 6.38, "have": 0}, {"len": 30, "price": 0, "have": 1}],
     "parts": [{"name": "Leg", "qty": 4, "len": 16.5}, {"name": "Long rail", "qty": 4, "len": 41}]},
    {"kind": "board", "name": "1×6 board", "note": "¾ × 5½ in", "wid": 5.5,
     "stock": [{"len": 96, "price": 8.28, "have": 0}],
     "parts": [{"name": "Stile", "qty": 2, "len": 30, "wid": 1.5}, {"name": "Shelf", "qty": 1, "len": 30}]},
    {"kind": "sheet", "name": "¾ plywood", "note": "23/32 in actual",
     "stock": [{"len": 96, "wid": 48, "price": 58, "have": 0}],
     "parts": [{"name": "Seat", "qty": 1, "len": 48, "wid": 16, "grain": true}]}
  ]}}
```

## Fields

**Every length is a number in inches**, even when `units` is `"mm"`: 900 mm is `35.43307`. `units` only sets how Kerf shows lengths.

| Field | Meaning | Default when left out |
|---|---|---|
| `name` | Project name, up to 200 characters | `"Imported project"` |
| `units` | `"in"` or `"mm"` | `"in"` |
| `kerf` | Saw kerf in inches, 0–1; 3 mm = 0.11811 | 0.125 |
| `trim` | Inches squared off each board end, 0–6 | 0 |
| `edge` | Inches trimmed off each factory edge of a sheet before any other cut, 0–6; each sheet is planned that much smaller all round | 0 |
| `keep` | Offcuts at least this long (inches) are called out as worth keeping, 0–240 | 12 |
| `cur` | Currency sign, up to 3 characters | `"$"` |
| `notes` | The project's notes, up to 2,000 characters, line breaks kept (`\n`): hardware, glue-ups, finish, a spare board. Kerf shows them under the cut list and prints them on the shop PDF's first page | none |
| `materials[]` | Up to 100 materials | — |
| `materials[].kind` | `"board"` (one cross-section; parts have a length) or `"sheet"` (parts have a length and a width) | `"board"` |
| `materials[].name`, `note` | Shown as the material's title and subtitle, up to 200 characters each | `"Board"` or `"Sheet"`, and no note |
| `materials[].examplePrices` | `true` while the material's prices are Kerf's own examples: the cut list says so until one is changed. Leave it out for prices you were given | none |
| `materials[].wid` | Boards only: the board's actual width in inches (a 1×6 is 5.5), up to 1200. With it, board parts can have a `wid` too, and are ripped from the board | none, and board parts' widths are ignored |
| `stock[]` | Up to 50 sizes per material, to buy or already on hand: `len` (and `wid` for sheets) in inches, up to 1200, a sheet's `len` being the way its grain runs (a 4×8 sheet is `len` 96, `wid` 48); `price` each, up to 100000; `have` = pieces on hand (0 = buy; on-hand pieces are free and used whenever they save buying; at most 10) | `price` 0, which makes the size free, so always give one; `have` 0 |
| `parts[]` | Up to 1000 rows per material: `name` (up to 200 characters), `qty` (whole number 1–500), `len` (inches, up to 1200), and for sheets `wid` and `grain`; for boards with a `wid`, an optional `wid` for a part ripped narrower than the board | `qty` 1; a board part's `wid`, the whole board's |
| `grain` | `true` keeps the grain along the part's `len`, and Kerf won't turn the part | `true` |

A sheet's `len` is the way its grain runs, as a part's is, and Kerf plans and draws the sheet that way round. A grain-locked sheet part's `len` must fit along the sheet's `len` and its `wid` across the sheet's `wid`. Give store sheets long side first, the way their grain runs: `len` 96, `wid` 48.

A board part with a `wid` narrower than its board's `wid` is ripped from it: Kerf plans that material's boards like sheets as wide as the board, grain along the length, and the steps rip and crosscut "the board". A part with no `wid` (or the board's) takes the whole width; one wider than the board doesn't fit. Use it for face-frame stiles, edging and drawer sides cut from wider stock.

Kerf plans at most 300 of one sheet part; for more, split it into two rows.

Kerf ignores fields it doesn't know. It clamps out-of-range numbers and drops sizes with no length, so a small slip degrades quietly instead of failing. Past the limits above it keeps the first rows and says how many it left out. A material with parts but no usable size gets the size Kerf's **Other board** or **Other sheet** starts with (an 8′ board, or a 4×8 sheet), and Kerf says to check the sizes. Get the inches right.

## Links

A link is Kerf's address with the project in the fragment:

```
https://kerf.junkdrawer.works/#k1z<data>
```

`<data>` is the compact JSON above, compressed with raw DEFLATE, then base64url-encoded without padding. A bench comes to about 600 characters and 100 parts to about 2,000; past that, offer the file first, since some apps cut long links short. `#k1j<data>` is the same without compression. Kerf also accepts `#project=<URL-encoded JSON>`, which can be written by hand, but it gets long.

Opening a link, a file or pasted text shows the project and asks before adding it. It never replaces an existing project, and opening the same project again, by any of the three, offers the copy already in Kerf. A link pasted into the box under **Projects** opens the same way (on an iPhone a tapped link opens in Safari, not in Kerf on the home screen, and Safari keeps its own projects; Kerf says so there and offers a **Copy link** button).
