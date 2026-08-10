#![no_main]

use libfuzzer_sys::fuzz_target;
use opengeni_artifact_kernel::{
    encode_collaboration_snapshot, AtomicBatch, CausalFrontier, CollaborativeWorkbook, Command,
    ReplicaId, StableId,
};
use opengeni_artifact_kernel_binding_protocol::{
    canonicalize_collaboration_snapshot, canonicalize_snapshot, create_workbook,
    decode_causal_frontier, decode_command_batch, decode_receipt, derive_intent_identities,
    encode_causal_frontier, encode_command_batch, encode_namespace, BindingSession,
};

const MAX_INPUT_BYTES: usize = 64 * 1024;

fuzz_target!(|input: &[u8]| {
    let bytes = &input[..input.len().min(MAX_INPUT_BYTES)];
    check(bytes);

    let create = AtomicBatch::from_commands(vec![Command::CreateSheet {
        id: StableId::from_parts(1, 2),
        name: "Fuzz".into(),
    }]);
    let command = encode_command_batch(&create).expect("seed command");
    check(&mutated(&command, bytes));

    let frontier = encode_causal_frontier(
        &CausalFrontier::from_entries([(ReplicaId::new(1).expect("replica"), 1)])
            .expect("seed frontier"),
    )
    .expect("seed frontier envelope");
    check(&mutated(&frontier, bytes));

    let namespace = encode_namespace(1);
    let snapshot = create_workbook(&namespace).expect("seed snapshot");
    check(&mutated(&snapshot, bytes));

    let collaboration =
        encode_collaboration_snapshot(&CollaborativeWorkbook::new(1).expect("seed collaboration"))
            .expect("seed collaboration snapshot");
    check(&mutated(&collaboration, bytes));

    let mut session = BindingSession::create(&namespace).expect("seed session");
    let receipt = session.apply_commands(&command).expect("seed receipt");
    check(&mutated(&receipt, bytes));

    check(&mutated(&seed_intent(), bytes));
});

fn check(bytes: &[u8]) {
    if let Ok(batch) = decode_command_batch(bytes) {
        assert_eq!(
            encode_command_batch(&batch).expect("accepted command batch must encode"),
            bytes,
            "accepted command batch was not canonical",
        );
    }
    if let Ok(frontier) = decode_causal_frontier(bytes) {
        assert_eq!(
            encode_causal_frontier(&frontier).expect("accepted frontier must encode"),
            bytes,
            "accepted causal frontier was not canonical",
        );
    }
    let _ = decode_receipt(bytes);
    let _ = derive_intent_identities(bytes, 1);

    if let Ok(canonical) = canonicalize_snapshot(bytes) {
        assert_eq!(
            canonicalize_snapshot(&canonical).expect("canonical snapshot must reopen"),
            canonical,
        );
    }
    if let Ok(canonical) = canonicalize_collaboration_snapshot(bytes) {
        assert_eq!(
            canonicalize_collaboration_snapshot(&canonical)
                .expect("canonical collaboration snapshot must reopen"),
            canonical,
        );
    }
}

fn mutated(seed: &[u8], input: &[u8]) -> Vec<u8> {
    let mut output = seed.to_vec();
    for (index, byte) in input.iter().take(4_096).enumerate() {
        let position = index % output.len();
        output[position] ^= byte;
    }
    output
}

fn seed_intent() -> Vec<u8> {
    let mut output = Vec::new();
    output.extend_from_slice(b"OGATX001");
    output.extend_from_slice(&1u16.to_le_bytes());
    output.extend_from_slice(&1u16.to_le_bytes());
    output.extend_from_slice(&1u16.to_le_bytes());
    output.extend_from_slice(&1u16.to_le_bytes());
    push_string(&mut output, "11111111111111111111111111111111");
    push_string(&mut output, "fuzz-transaction");
    push_string(&mut output, "1111111111111111");
    output.extend_from_slice(&1u64.to_le_bytes());
    output.push(0);
    output.extend_from_slice(&0u64.to_le_bytes());
    output.extend_from_slice(&0u16.to_le_bytes());
    output.extend_from_slice(&0u16.to_le_bytes());
    output.extend_from_slice(&1u32.to_le_bytes());
    output.push(0);
    output
}

fn push_string(output: &mut Vec<u8>, value: &str) {
    output.extend_from_slice(&(value.len() as u16).to_le_bytes());
    output.extend_from_slice(value.as_bytes());
}
