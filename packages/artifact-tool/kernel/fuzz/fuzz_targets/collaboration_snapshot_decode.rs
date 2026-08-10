#![no_main]

use libfuzzer_sys::fuzz_target;
use opengeni_artifact_kernel::{
    decode_collaboration_snapshot, encode_collaboration_snapshot, CollaborativeWorkbook,
};

fuzz_target!(|bytes: &[u8]| {
    check(bytes);

    // Preserve a structurally valid path even from an empty corpus so length,
    // checksum, transaction, frontier, and embedded-model decoding all receive
    // continuous mutations instead of waiting to discover the magic header.
    let mut near_valid = encode_collaboration_snapshot(
        &CollaborativeWorkbook::new(1).expect("seed collaborative workbook"),
    )
    .expect("seed collaboration snapshot");
    for (index, byte) in bytes.iter().take(4_096).enumerate() {
        let position = index % near_valid.len();
        near_valid[position] ^= byte;
    }
    check(&near_valid);
});

fn check(bytes: &[u8]) {
    if let Ok(workbook) = decode_collaboration_snapshot(bytes) {
        let canonical =
            encode_collaboration_snapshot(&workbook).expect("accepted model must encode");
        let decoded =
            decode_collaboration_snapshot(&canonical).expect("canonical bytes must decode");
        assert_eq!(decoded, workbook);
        assert_eq!(
            encode_collaboration_snapshot(&decoded).expect("round-trip encode"),
            canonical
        );
    }
}
