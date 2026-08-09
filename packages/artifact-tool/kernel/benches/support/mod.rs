use std::collections::BTreeSet;

pub fn test_font(characters: &str, advance: u16) -> Vec<u8> {
    let codepoints = characters
        .chars()
        .filter(|character| !matches!(character, '\n' | '\r' | '\u{200d}'))
        .map(u32::from)
        .collect::<BTreeSet<_>>();
    let glyph_count = u16::try_from(codepoints.len() + 1).expect("fixture glyph count");
    let mut cmap = Vec::new();
    be_u16(&mut cmap, 0);
    be_u16(&mut cmap, 1);
    be_u16(&mut cmap, 3);
    be_u16(&mut cmap, 10);
    be_u32(&mut cmap, 12);
    be_u16(&mut cmap, 12);
    be_u16(&mut cmap, 0);
    be_u32(&mut cmap, (16 + codepoints.len() * 12) as u32);
    be_u32(&mut cmap, 0);
    be_u32(&mut cmap, codepoints.len() as u32);
    for (index, codepoint) in codepoints.iter().copied().enumerate() {
        be_u32(&mut cmap, codepoint);
        be_u32(&mut cmap, codepoint);
        be_u32(&mut cmap, (index + 1) as u32);
    }

    let mut head = vec![0u8; 54];
    put_u32(&mut head, 0, 0x0001_0000);
    put_u32(&mut head, 4, 0x0001_0000);
    put_u32(&mut head, 12, 0x5f0f_3cf5);
    put_u16(&mut head, 18, 1_000);
    put_i16(&mut head, 38, -200);
    put_i16(&mut head, 40, advance as i16);
    put_i16(&mut head, 42, 800);
    put_u16(&mut head, 46, 8);
    put_i16(&mut head, 48, 2);

    let mut hhea = vec![0u8; 36];
    put_u32(&mut hhea, 0, 0x0001_0000);
    put_i16(&mut hhea, 4, 800);
    put_i16(&mut hhea, 6, -200);
    put_i16(&mut hhea, 8, 200);
    put_u16(&mut hhea, 10, advance);
    put_i16(&mut hhea, 16, advance as i16);
    put_i16(&mut hhea, 18, 1);
    put_u16(&mut hhea, 34, glyph_count);

    let mut hmtx = Vec::with_capacity(glyph_count as usize * 4);
    for _ in 0..glyph_count {
        be_u16(&mut hmtx, advance);
        be_i16(&mut hmtx, 0);
    }
    let mut maxp = Vec::with_capacity(6);
    be_u32(&mut maxp, 0x0000_5000);
    be_u16(&mut maxp, glyph_count);
    let tables = vec![
        (*b"cmap", cmap),
        (*b"head", head),
        (*b"hhea", hhea),
        (*b"hmtx", hmtx),
        (*b"maxp", maxp),
    ];
    let mut font = Vec::new();
    be_u32(&mut font, 0x0001_0000);
    be_u16(&mut font, tables.len() as u16);
    be_u16(&mut font, 64);
    be_u16(&mut font, 2);
    be_u16(&mut font, tables.len() as u16 * 16 - 64);
    let directory = font.len();
    font.resize(directory + tables.len() * 16, 0);
    let mut offset = font.len();
    for (index, (tag, table)) in tables.into_iter().enumerate() {
        while offset % 4 != 0 {
            font.push(0);
            offset += 1;
        }
        let entry = directory + index * 16;
        font[entry..entry + 4].copy_from_slice(&tag);
        put_u32(&mut font, entry + 4, checksum(&table));
        put_u32(&mut font, entry + 8, offset as u32);
        put_u32(&mut font, entry + 12, table.len() as u32);
        font.extend_from_slice(&table);
        offset += table.len();
    }
    font
}

fn checksum(bytes: &[u8]) -> u32 {
    bytes.chunks(4).fold(0u32, |sum, chunk| {
        let mut word = [0u8; 4];
        word[..chunk.len()].copy_from_slice(chunk);
        sum.wrapping_add(u32::from_be_bytes(word))
    })
}

fn be_u16(output: &mut Vec<u8>, value: u16) {
    output.extend_from_slice(&value.to_be_bytes());
}
fn be_i16(output: &mut Vec<u8>, value: i16) {
    output.extend_from_slice(&value.to_be_bytes());
}
fn be_u32(output: &mut Vec<u8>, value: u32) {
    output.extend_from_slice(&value.to_be_bytes());
}
fn put_u16(output: &mut [u8], offset: usize, value: u16) {
    output[offset..offset + 2].copy_from_slice(&value.to_be_bytes());
}
fn put_i16(output: &mut [u8], offset: usize, value: i16) {
    output[offset..offset + 2].copy_from_slice(&value.to_be_bytes());
}
fn put_u32(output: &mut [u8], offset: usize, value: u32) {
    output[offset..offset + 4].copy_from_slice(&value.to_be_bytes());
}
