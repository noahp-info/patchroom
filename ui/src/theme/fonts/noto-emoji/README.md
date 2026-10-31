# Noto Color Emoji (bundled web font)

Noto Color Emoji, Copyright 2021 Google Inc., SIL Open Font License 1.1 (see OFL.txt).
Source: https://github.com/googlefonts/noto-emoji (2D/fonts/NotoColorEmoji.ttf and 2D/fonts/Noto-COLRv1.ttf, main branch).

## Files

- NotoEmojiCOLRv1.woff2: COLRv1 vector build. Used by Chromium (Playwright CI).
- NotoEmojiSbix.woff2: bitmap (PNG) build in `sbix` format, converted from the CBDT build. Used by WebKit (WKWebView).
- build-sbix.py: converts the subset CBDT TTF to sbix (adds empty glyf/loca so the font validates).

WebKit does not render COLRv1 (glyphs come out blank) and rejects CBDT, so the sbix conversion is required.

## Build commands

Run from a scratch dir with the two upstream TTFs.

    U='0023,002A,0030-0039,00A9,00AE,200D,203C,2049,20E3,2122,2139,2194-21AA,231A-23FF,24C2,25AA-25FE,2600-27BF,2934-2935,2B05-2B55,3030,303D,3297,3299,1F000-1FAFF,1F1E6-1F1FF,E0020-E007F,FE0F'
    pyftsubset Noto-COLRv1.ttf --unicodes="$U" --layout-features='*' --flavor=woff2 --output-file=NotoEmojiCOLRv1.woff2
    pyftsubset NotoColorEmoji.ttf --unicodes="$U" --layout-features='*' --glyph-names --notdef-outline --output-file=cbdt-sub.ttf
    python3 -I build-sbix.py cbdt-sub.ttf sbix.ttf
    python3 -I -c "from fontTools.ttLib import TTFont; t=TTFont('sbix.ttf'); t.flavor='woff2'; t.save('NotoEmojiSbix.woff2')"

## CSS

    @font-face {
      font-family: 'Noto Color Emoji Patchroom';
      src: url('./NotoEmojiCOLRv1.woff2') format('woff2') tech(color-COLRv1),
           url('./NotoEmojiSbix.woff2') format('woff2');
      font-display: swap;
    }
