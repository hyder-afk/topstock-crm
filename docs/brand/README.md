> **TopStock repo copy (7 Oct 2026):** only the essentials of Brand Pack v9 are here (this README, tokens, a few logo SVGs, the fonts with their licence). The folder list below describes the full pack, which Haider keeps. One em dash in the hero copy was replaced with a full stop (the UI bans em dashes).

# TopStock Wholesale: Brand Pack v9

Everything for the TopStock identity. Every asset comes as a vector **SVG master** plus an **HD PNG**; stationery and labels also as print-ready **PDF**, the letterhead as **DOCX**.

## The idea

**The block T.** A heavy T, 100 × 130, in the language of the team's reference: the crossbar's top-left corner and the stem's right foot are cut at 45°, and one arrow is cut out of it, pointing up and to the right: the head sits in the bar's corner and the shaft runs at 45° down through the shoulder into the stem. The arrow is the only thing inside it; everything else is solid. Stock, going up.

**topstock** is the wordmark: the company's original geometric letterforms, redrawn as vector. Unicase letters, 100 tall with a 20 stroke; the t has a hooked foot, the s is two squared C's, and the k rises into an arrow. In the primary lockup the mark stands in for the t: **[mark]opstock**, the mark 1.09 letter heights tall, standing on the baseline so the extra rises above the cap line, with a clear gap of 0.06 letter heights to the o. `lockup-full` puts the mark beside the whole word; `wordmark-plain` is the word with an ordinary k, for very small sizes.

**The wall** is the container's corrugated side, cropped edge to edge: the hero image, the cover, the backdrop. **The container** is a full 20-foot box drawn in vector.

Tagline: **Small start. Same grade. Big orders.**

## Voice and copy

The brand speaks short, specific and generous: it offers the test bale before anyone asks, never oversells a lot, and tells a buyer which one fits. Numbers over adjectives; one red word per headline; no exclamation marks; lowercase only on social.

- **Tagline:** Small start. Same grade. Big orders.
- **Hero:** Less sorting. More selling. We do the grading so your floor doesn't have to. Graded second-hand clothing in sealed, tagged bales, from one test bale to a full container. [Order a test bale] [Talk to us on WhatsApp]
- **Manifesto:** Start small. We grow with you. A test bale before a container. The same grade every order. A straight answer on WhatsApp, even when it's "not this lot."
- **Three points:** Graded, not guessed (every bale sorted by hand and tagged with its grade, weight and category) · Start with one bale (test bale first, container second; order sizes that fit where you are) · People, not a portal (a real person answers, helps you pick, and says when a lot isn't right for you).
- **How it works:** 1 Tell us what you sell. 2 Order a test bale. 3 Scale when you're ready, at the same grade every time.
- **About, short:** TopStock supplies graded second-hand clothing to resellers, exporters and thrift retailers. Every bale is sorted by hand, tagged with its grade and sealed. Start with a test bale; scale to a container when it's working.
- **CTAs:** Order a test bale (primary) · Talk to us on WhatsApp · Request the price list · Book a container.
- **WhatsApp opener:** Hi, thanks for messaging TopStock. Tell us what you sell, the grade you're after and roughly how many kilos a month, and we'll suggest a test bale to start with. No pressure to go bigger until it's working for you.
- **Social captions:** One test bale. Then decide. · Less sorting. More selling. · Graded, not guessed. · Start with a bale. Grow to a container. We'll be here for both.
- **Email signature line:** Small start. Same grade. Big orders.

## Colour

| Name | Hex | Use |
|---|---|---|
| TopStock Black | `#0E0E10` | Backgrounds, the body of everything |
| Signal Red | `#F2203E` | The mark, highlights, CTAs, the wall, the container |
| Chalk White | `#F5F3EF` | Type and the wordmark on dark grounds |
| Charcoal | `#1C1C21` | Cards, panels, the second surface |
| Steel Grey | `#8C8C94` | Captions and secondary text on dark grounds |
| Deep Red | `#B5122F` | Shading in illustration only, never for type |

Rules: red text on black only at 18px and up (4.6:1). White on red is for logos and large type (3.8:1); use black for small text on red. Deep Red never carries type.

## Type

**Outfit** for everything: Bold for the wordmark and headlines (−3% tracking), Regular for text. **DM Mono** for lot codes, labels and specs. Both are free Google Fonts and are in `11_fonts/` with their licence.

## Logo rules

- Clear space: half the mark's height on every side.
- Minimum size: primary lockup 180px wide (letters 24px tall; below that the arrow in the mark closes up, so use `wordmark-plain` or the tile); 40mm in print; wordmark 100px (use `wordmark-plain` below 100px, where the k arrow closes up); submark 24px (the arrows inside need it).
- Use the supplied files. Never retype the name as a logo (the letters are not a font); never redraw the mark; never change the mark's size against the letters.
- On black and charcoal: red mark, white word. On white: red mark, black word. On red: all white. On photographs: one colour, white.
- Never rotate, stretch, outline, add shadows or gradients, or change the proportions.

## Folders

```
01_logo/            primary (the mark as the t: [mark]opstock), lockup-full (mark + topstock), wordmark, wordmark-plain, stacked, tagline
                    schemes: on-black, on-white, on-red, on-charcoal (+ _transparent) and one-colour white / black / red
                    submark tiles and bare marks, hex and circle badges · svg/ masters · png/ HD (4000px; symbols 3000px)
02_icons/           app icons (1024/512/192/180), rounded preview, Android adaptive layers, favicon.svg/.ico/PNGs, social profiles (2048)
03_whatsapp/        WhatsApp avatars and layers (640 = WhatsApp native, 1080, 2048)
04_pattern/         the mark pattern (4 colourways), the wall (with and without the lockup), the container (3D, elevation, door end)
05_mockups/         rendered scenes: warehouse, card on concrete, bales, cartons, bale tag, app icon, tote, tee, truck, wall (4K),
                    vertical/ 9:16 versions for stories and reels, plus business cards and billboard
06_stationery/      letterhead (SVG, PNG, PDF, DOCX) + continuation sheet, invoice, quotation, price list (SVG, PNG, PDF),
                    email signature (PNG + HTML), templates/ (business card, social post, story, shipping label)
07_labels/          bale tag 100x150, roll label 100x50, round stickers, container seal, packing tape, staff ID (PDFs for the printed ones)
08_uniform-livery/  polo (black, white), cap, hi-vis vest, truck livery, fascia sign
09_social/          LinkedIn cover (content left, clear of the profile photo; a guides version shows where the photo sits), LinkedIn banner (centred),
                    Facebook cover, YouTube banner (safe area marked), supergraphics (16:9 and square, white and tone on tone), WhatsApp status, Instagram posts
11_fonts/           Outfit Bold, Outfit Regular, DM Mono Medium, OFL licence
tokens.css / tokens.json   design tokens for developers (the mark's path is in tokens.json)
```

## WhatsApp avatars

- **Brand account:** `brand-avatar_red / black / white`.
- **Employee, branded:** `employee-template_blank` is the empty template; `employee-avatar_example` shows it with an illustrated stand-in. Swap in a real photo.
- **Employee, solid colour + corner mark:** `employee-solid_red_*` and `employee-solid_black_*` (blank and example).
- **Build your own:** stack `layer_1_background` → employee cut-out (transparent PNG, shoulders up) → `layer_3_badge` (or a `layer_3_corner-mark`). For a normal photo with its own background, place it full-bleed and put `photo-frame_overlay` on top. `employee-template_guides` shows the safe zone.
- **Upload:** a square PNG, 1080×1080 (at least 640×640). WhatsApp crops it to a circle, so keep the face inside the central 80% with about 15% headroom.

The guidelines page has an **Avatar Maker**: upload a photo, drag and pinch it into place, pick a style and download a ready 640 or 1080 PNG.

## Contrast (WCAG 2.1)

| Foreground | Background | Ratio | Use |
|---|---|---|---|
| Chalk White | TopStock Black | 17.4:1 | AAA |
| Signal Red | TopStock Black | 4.64:1 | AA |
| Steel Grey | TopStock Black | 5.78:1 | AA |
| Chalk White | Charcoal | 15.31:1 | AAA |
| Signal Red | Charcoal | 4.08:1 | AA large / logo |
| Chalk White | Signal Red | 3.75:1 | AA large / logo |
| TopStock Black | Signal Red | 4.64:1 | AA |
| TopStock Black | Chalk White | 17.4:1 | AAA |
| Signal Red | Chalk White | 3.75:1 | AA large / logo |
| Steel Grey | Chalk White | 3.01:1 | AA large / logo |
| Deep Red | TopStock Black | 2.84:1 | Avoid for text |
| Deep Red | Chalk White | 6.13:1 | AA |

## Placeholders

Every field in square brackets ([Phone number], [Full name], [Street address], [2417] and so on) is a placeholder. Replace them before printing. The container number on the art (TSWU 241708 3) is a placeholder in the ISO 6346 format. Barcodes on the labels are placeholders too: generate real ones from your lot numbers.
