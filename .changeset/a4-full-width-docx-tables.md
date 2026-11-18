---
"@opengeni/artifact-tool": patch
"@opengeni/artifact-kernel-wasm-document": patch
---

Documents on pages whose text width is not a whole number of points, such as A4 with 1 inch or 2 cm margins, can now hold a table exactly as wide as the text area, and such DOCX files import again. The width checks compared against a floating-point usable width (595.3 - 72 - 72 = 451.29999999999995), so a full-width 9026-twip table (451.3pt) was rejected, and DOCX export rounded each grid column up independently, so a default three-column A4 table was written 1 twip wider than the page. Width checks now allow the same 0.01pt slack as the column-sum check, and export trims any rounding excess so the grid never exceeds the serialized text width.
