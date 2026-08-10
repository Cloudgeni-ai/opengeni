#![no_main]

use libfuzzer_sys::fuzz_target;
use opengeni_artifact_kernel::{decode_snapshot, encode_snapshot, Workbook};

fuzz_target!(|bytes: &[u8]| {
    check(bytes);

    // An empty corpus almost never discovers the eight-byte magic naturally.
    // Also project arbitrary input onto a valid seed so mutations continuously
    // exercise lengths, checksum handling, and the structured decoder.
    let mut near_valid =
        encode_snapshot(&Workbook::new(1).expect("seed workbook")).expect("seed snapshot");
    for (index, byte) in bytes.iter().take(4_096).enumerate() {
        let position = index % near_valid.len();
        near_valid[position] ^= byte;
    }
    check(&near_valid);
});

fn check(bytes: &[u8]) {
    if let Ok(workbook) = decode_snapshot(bytes) {
        let canonical = encode_snapshot(&workbook).expect("accepted model must encode");
        let decoded = decode_snapshot(&canonical).expect("canonical bytes must decode");
        assert_eq!(decoded, workbook);
        assert_eq!(
            encode_snapshot(&decoded).expect("round-trip encode"),
            canonical
        );
    }
}
