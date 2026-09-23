//! Connection-instance-local transactional upload lifecycle. No op frames,
//! child processes, implicit authority, automatic retries, or restart adoption.

use opengeni_agent_platform::{transactional_write::TransactionalWrite, Platform, PlatformError};
use opengeni_agent_proto::v1::{self, control_request::Op, control_response::Result as ResultBody};
use std::collections::HashMap;

/// Existing protocol chunk bound (not a host workload policy).
const CHUNK_BYTES: usize = 512 * 1024;

/// A disjoint operation namespace so query/cancel can route without guessing.
pub fn is_upload_id(id: &str) -> bool {
    id.starts_with("fsw-")
}

/// A handler panic/poisoned registry cannot establish whether publication won.
pub fn unknown_response(request_id: String) -> v1::ControlResponse {
    v1::ControlResponse {
        request_id,
        error: Some(error(
            v1::ErrorCode::Os,
            "WRITE_OUTCOME_UNKNOWN",
            "upload outcome is unknown; do not restart or retry the write",
        )),
        result: None,
    }
}

/// True only for transactional operations, including unsupported attachment.
pub fn handles(request: &v1::ControlRequest) -> bool {
    match &request.op {
        Some(Op::OpStart(start)) => matches!(start.op, Some(v1::op_start::Op::FsWrite(_))),
        Some(Op::WriteChunk(_)) => true,
        Some(Op::OpQuery(op)) => is_upload_id(&op.op_id),
        Some(Op::OpCancel(op)) => is_upload_id(&op.op_id),
        Some(Op::OpAttach(op)) => is_upload_id(&op.op_id),
        _ => false,
    }
}

#[derive(PartialEq, Eq)]
struct ChunkIdentity {
    seq: u64,
    offset: u64,
    last: bool,
    length: usize,
    digest: blake3::Hash,
}

impl From<&v1::WriteChunk> for ChunkIdentity {
    fn from(chunk: &v1::WriteChunk) -> Self {
        Self {
            seq: chunk.seq,
            offset: chunk.offset,
            last: chunk.last,
            length: chunk.bytes.len(),
            digest: blake3::hash(&chunk.bytes),
        }
    }
}

struct Upload {
    epoch: u32,
    begin: Option<v1::OpStart>,
    staged: Option<Box<dyn TransactionalWrite>>,
    last: Option<ChunkIdentity>,
    status: v1::OpStatus,
}

/// Owned by one WorkspaceLink: connection scope AND process instance, never
/// shared between links. Records live until the link is dropped; staging drops
/// on cancel/failure/commit. Process death does not mint a resumable transaction.
#[derive(Default)]
pub struct Uploads {
    records: HashMap<String, Upload>,
}

fn error(code: v1::ErrorCode, failure: &str, message: &str) -> v1::AgentError {
    v1::AgentError {
        code: code as i32,
        message: message.into(),
        retryable: false,
        detail: [("failure_code".into(), failure.into())].into(),
    }
}

fn protocol(failure: &str, message: &str) -> v1::AgentError {
    error(v1::ErrorCode::Protocol, failure, message)
}

fn platform_error(error: &PlatformError) -> v1::AgentError {
    let mut wire = error.to_agent_error();
    wire.retryable = false;
    if wire
        .detail
        .get("failure_code")
        .is_some_and(|code| code == "WRITE_FENCED")
    {
        wire.code = v1::ErrorCode::Fenced as i32;
    }
    wire.detail.entry("failure_code".into()).or_insert_with(|| {
        if wire.code == v1::ErrorCode::Unsupported as i32 {
            "WRITE_UNSUPPORTED".into()
        } else {
            "WRITE_IO".into()
        }
    });
    wire
}

fn valid_id(id: &str) -> bool {
    is_upload_id(id)
        && id.len() > 4
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

impl Uploads {
    /// Caller serializes through the exact link's mutex on a blocking thread.
    /// The live epoch predicate is also passed down to the actual commit point.
    pub fn serve<P: Platform>(
        &mut self,
        platform: &P,
        request: &v1::ControlRequest,
        current_epoch: &dyn Fn() -> u32,
    ) -> v1::ControlResponse {
        let result = self.dispatch(platform, request, current_epoch);
        match result {
            Ok(result) => v1::ControlResponse {
                request_id: request.request_id.clone(),
                error: None,
                result: Some(result),
            },
            Err(error) => v1::ControlResponse {
                request_id: request.request_id.clone(),
                error: Some(error),
                result: None,
            },
        }
    }

    fn dispatch<P: Platform>(
        &mut self,
        platform: &P,
        request: &v1::ControlRequest,
        current_epoch: &dyn Fn() -> u32,
    ) -> Result<ResultBody, v1::AgentError> {
        if request.epoch == 0 || request.epoch != current_epoch() {
            return Err(error(
                v1::ErrorCode::Fenced,
                "WRITE_FENCED",
                "transaction requires exact current nonzero epoch",
            ));
        }
        if request.resource_policy.is_some() {
            return Err(error(
                v1::ErrorCode::Unsupported,
                "WRITE_UNSUPPORTED",
                "upload does not accept execution resource policy",
            ));
        }
        match &request.op {
            Some(Op::OpStart(start)) => {
                self.begin(platform, &request.request_id, request.epoch, start)
            }
            Some(Op::WriteChunk(chunk)) => {
                self.chunk(request.epoch, chunk, &|| request.epoch == current_epoch())
            }
            Some(Op::OpQuery(query)) => Ok(ResultBody::OpStatus(
                self.status(&query.op_id, request.epoch)?,
            )),
            Some(Op::OpCancel(cancel)) => self.cancel(&cancel.op_id, request.epoch),
            _ => Err(error(
                v1::ErrorCode::Unsupported,
                "WRITE_UNSUPPORTED",
                "uploads have no frames or attachment; use OpQuery",
            )),
        }
    }

    fn begin<P: Platform>(
        &mut self,
        platform: &P,
        id: &str,
        epoch: u32,
        start: &v1::OpStart,
    ) -> Result<ResultBody, v1::AgentError> {
        if !valid_id(id) {
            return Err(protocol(
                "WRITE_ID",
                "upload operation ID must use fsw- namespace",
            ));
        }
        if let Some(record) = self.records.get(id) {
            if record.epoch != epoch {
                return Err(error(
                    v1::ErrorCode::Fenced,
                    "WRITE_FENCED",
                    "upload belongs to another epoch",
                ));
            }
            if record
                .begin
                .as_ref()
                .is_some_and(|original| original != start)
            {
                return Err(protocol(
                    "WRITE_DUPLICATE",
                    "begin payload differs from original",
                ));
            }
            return Ok(ResultBody::OpStart(v1::OpStarted {
                accepted: record.begin.is_some(),
                status: Some(record.status.clone()),
            }));
        }
        if start.window_bytes != 0 || start.deadline_ms != 0 {
            return Err(error(
                v1::ErrorCode::Unsupported,
                "WRITE_UNSUPPORTED",
                "uploads do not accept stream windows or deadlines",
            ));
        }
        let Some(v1::op_start::Op::FsWrite(begin)) = &start.op else {
            return Err(protocol("WRITE_CONTRACT", "expected FsWriteBegin"));
        };
        // Failed begins are terminal too: a lost error reply cannot silently
        // re-evaluate a filesystem precondition under the same identity.
        let result = platform
            .fs_write_begin(begin)
            .map_err(|error| platform_error(&error));
        let mut record = Upload {
            epoch,
            begin: Some(start.clone()),
            staged: None,
            last: None,
            status: v1::OpStatus {
                op_id: id.into(),
                state: v1::OpState::Running as i32,
                ..Default::default()
            },
        };
        match result {
            Ok(staged) => record.staged = Some(staged),
            Err(error) => {
                record.fail(&error);
                self.records.insert(id.into(), record);
                return Err(error);
            }
        }
        let status = record.status.clone();
        self.records.insert(id.into(), record);
        Ok(ResultBody::OpStart(v1::OpStarted {
            accepted: true,
            status: Some(status),
        }))
    }

    fn status(&self, id: &str, epoch: u32) -> Result<v1::OpStatus, v1::AgentError> {
        if !valid_id(id) {
            return Err(protocol("WRITE_ID", "invalid upload operation ID"));
        }
        match self.records.get(id) {
            Some(record) if record.epoch != epoch => Err(error(
                v1::ErrorCode::Fenced,
                "WRITE_FENCED",
                "upload belongs to another epoch",
            )),
            Some(record) => Ok(record.status.clone()),
            None => Ok(v1::OpStatus {
                op_id: id.into(),
                state: v1::OpState::Lost as i32,
                lost_reason: v1::OpLostReason::AgentRestarted as i32,
                ..Default::default()
            }),
        }
    }

    fn cancel(&mut self, id: &str, epoch: u32) -> Result<ResultBody, v1::AgentError> {
        self.status(id, epoch)?;
        let record = self.records.entry(id.into()).or_insert_with(|| Upload {
            epoch,
            begin: None,
            staged: None,
            last: None,
            status: v1::OpStatus {
                op_id: id.into(),
                ..Default::default()
            },
        });
        if record.status.state != v1::OpState::Complete as i32 {
            record.staged = None;
            record.status.state = v1::OpState::Complete as i32;
            record.status.exit = Some(v1::OpExit {
                cancelled: true,
                ..Default::default()
            });
        }
        Ok(ResultBody::OpStatus(record.status.clone()))
    }

    fn chunk(
        &mut self,
        epoch: u32,
        chunk: &v1::WriteChunk,
        authorized: &dyn Fn() -> bool,
    ) -> Result<ResultBody, v1::AgentError> {
        self.status(&chunk.op_id, epoch)?;
        if chunk.bytes.len() > CHUNK_BYTES {
            return Err(protocol(
                "WRITE_CHUNK_SIZE",
                "chunk exceeds existing 512 KiB protocol bound",
            ));
        }
        let record = self.records.get_mut(&chunk.op_id).ok_or_else(|| {
            protocol(
                "WRITE_UNKNOWN",
                "unknown upload; do not restart automatically",
            )
        })?;
        let identity = ChunkIdentity::from(chunk);
        if record.last.as_ref() == Some(&identity)
            && record
                .status
                .exit
                .as_ref()
                .is_none_or(|exit| !exit.cancelled && exit.failure_code.is_empty())
        {
            return Ok(ResultBody::WriteChunk(v1::WriteChunkAck { seq: chunk.seq }));
        }
        if record.staged.is_none() {
            return Err(protocol(
                "WRITE_COMPLETE",
                "upload is terminal; query its outcome",
            ));
        }
        if chunk.seq != record.status.next_seq
            || chunk.offset != record.status.write_offset
            || (!chunk.last && chunk.bytes.is_empty())
        {
            return Err(protocol(
                "WRITE_SEQUENCE",
                "chunk sequence/offset or duplicate body differs",
            ));
        }
        let next_seq = chunk
            .seq
            .checked_add(1)
            .ok_or_else(|| protocol("WRITE_SEQUENCE", "sequence overflow"))?;
        let next_offset = chunk
            .offset
            .checked_add(chunk.bytes.len() as u64)
            .ok_or_else(|| protocol("WRITE_SIZE", "offset overflow"))?;
        let staged = record.staged.as_mut().expect("checked staging");
        let result = staged.append(&chunk.bytes).and_then(|()| {
            if chunk.last {
                staged.commit(authorized)
            } else {
                Ok(())
            }
        });
        if let Err(error) = result {
            let error = platform_error(&error);
            record.fail(&error);
            return Err(error);
        }
        record.status.next_seq = next_seq;
        record.status.write_offset = next_offset;
        record.last = Some(identity);
        if chunk.last {
            let Some(v1::op_start::Op::FsWrite(begin)) =
                record.begin.as_ref().and_then(|start| start.op.as_ref())
            else {
                unreachable!("upload begin")
            };
            record.status.state = v1::OpState::Complete as i32;
            record.status.exit = Some(v1::OpExit {
                digests: [("content".into(), begin.content_digest.clone())].into(),
                totals: [("content".into(), next_offset)].into(),
                ..Default::default()
            });
            record.staged = None;
        }
        Ok(ResultBody::WriteChunk(v1::WriteChunkAck { seq: chunk.seq }))
    }
}

impl Upload {
    fn fail(&mut self, error: &v1::AgentError) {
        self.staged = None;
        self.status.state = v1::OpState::Complete as i32;
        self.status.exit = Some(v1::OpExit {
            failure_code: error
                .detail
                .get("failure_code")
                .cloned()
                .unwrap_or_else(|| "WRITE_IO".into()),
            failure_detail: error.detail.clone(),
            ..Default::default()
        });
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use opengeni_agent_platform::NativePlatform;

    const ID: &str = "fsw-synthetic";

    struct Rig {
        dir: tempfile::TempDir,
        platform: NativePlatform,
        uploads: Uploads,
    }
    impl Rig {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            Self {
                platform: NativePlatform::with_root(dir.path()),
                dir,
                uploads: Uploads::default(),
            }
        }
        fn call(&mut self, op: Op) -> v1::ControlResponse {
            self.uploads.serve(&self.platform, &request(op, 7), &|| 7)
        }
        fn begin(&mut self, bytes: &[u8]) -> v1::ControlResponse {
            self.call(start(bytes))
        }
        fn query(&mut self) -> v1::OpStatus {
            let Some(ResultBody::OpStatus(status)) = self
                .call(Op::OpQuery(v1::OpQuery { op_id: ID.into() }))
                .result
            else {
                panic!("status");
            };
            status
        }
    }

    fn request(op: Op, epoch: u32) -> v1::ControlRequest {
        v1::ControlRequest {
            request_id: ID.into(),
            epoch,
            op: Some(op),
            ..Default::default()
        }
    }
    fn start(bytes: &[u8]) -> Op {
        Op::OpStart(v1::OpStart {
            op: Some(v1::op_start::Op::FsWrite(v1::FsWriteBegin {
                path: "document".into(),
                expected_absent: true,
                content_digest: blake3::hash(bytes).to_hex().to_string(),
                content_size: Some(bytes.len() as u64),
                ..Default::default()
            })),
            ..Default::default()
        })
    }
    fn chunk(seq: u64, offset: u64, bytes: &[u8], last: bool) -> Op {
        Op::WriteChunk(v1::WriteChunk {
            op_id: ID.into(),
            seq,
            offset,
            bytes: bytes.to_vec().into(),
            last,
        })
    }

    #[test]
    fn large_upload_has_verified_receipt_and_exact_lost_ack_replay() {
        let mut rig = Rig::new();
        let bytes = vec![b'x'; 3 * CHUNK_BYTES + 13];
        assert!(rig.begin(&bytes).error.is_none());
        assert!(rig.begin(&bytes).error.is_none());
        for (seq, body) in bytes.chunks(CHUNK_BYTES).enumerate() {
            let offset = seq * CHUNK_BYTES;
            let op = chunk(
                seq as u64,
                offset as u64,
                body,
                offset + body.len() == bytes.len(),
            );
            assert!(rig.call(op.clone()).error.is_none());
            assert!(rig.call(op).error.is_none(), "exact latest chunk replay");
            let status = rig.query();
            assert_eq!(status.next_seq, seq as u64 + 1);
            assert_eq!(status.write_offset, (offset + body.len()) as u64);
        }
        let path = rig.dir.path().join("document");
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        let status = rig.query();
        assert_eq!(status.state, v1::OpState::Complete as i32);
        let exit = status.exit.unwrap();
        assert_eq!(exit.totals["content"], bytes.len() as u64);
        assert_eq!(
            exit.digests["content"],
            blake3::hash(&bytes).to_hex().to_string()
        );
        // Replaying final/complete begin never replaces subsequent external work.
        std::fs::write(&path, b"external").unwrap();
        assert!(rig
            .call(chunk(
                3,
                (3 * CHUNK_BYTES) as u64,
                &bytes[3 * CHUNK_BYTES..],
                true
            ))
            .error
            .is_none());
        assert!(rig.begin(&bytes).error.is_none());
        assert_eq!(std::fs::read(path).unwrap(), b"external");
    }

    #[test]
    fn changed_begin_duplicate_order_offset_and_oversize_are_refused_without_effects() {
        let mut rig = Rig::new();
        assert!(rig.begin(b"abcdef").error.is_none());
        assert!(rig.begin(b"other").error.is_some());
        assert!(rig.call(chunk(0, 0, b"abc", false)).error.is_none());
        for op in [
            chunk(0, 0, b"xyz", false),
            chunk(2, 3, b"def", true),
            chunk(1, 2, b"def", true),
            chunk(1, 3, &vec![0; CHUNK_BYTES + 1], true),
        ] {
            assert!(rig.call(op).error.is_some());
            assert!(!rig.dir.path().join("document").exists());
            assert_eq!(rig.query().write_offset, 3);
        }
        assert!(rig.call(chunk(1, 3, b"def", true)).error.is_none());
        assert!(
            rig.call(chunk(0, 0, b"abc", false)).error.is_some(),
            "old replay never re-applies"
        );
        assert_eq!(
            std::fs::read(rig.dir.path().join("document")).unwrap(),
            b"abcdef"
        );
    }

    #[test]
    fn digest_failure_is_terminal_and_never_retried_under_same_identity() {
        let mut rig = Rig::new();
        assert!(rig.begin(b"good").error.is_none());
        assert!(rig.call(chunk(0, 0, b"evil", true)).error.is_some());
        assert!(!rig.dir.path().join("document").exists());
        assert_eq!(rig.query().exit.unwrap().failure_code, "WRITE_DIGEST");
        assert!(rig.call(chunk(0, 0, b"good", true)).error.is_some());
        assert!(rig.begin(b"good").error.is_none());
        assert_eq!(rig.query().state, v1::OpState::Complete as i32);
        assert_eq!(std::fs::read_dir(rig.dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn cancel_before_begin_and_after_chunk_are_terminal_and_remove_staging() {
        for begin_first in [false, true] {
            let mut rig = Rig::new();
            if begin_first {
                assert!(rig.begin(b"hello").error.is_none());
                assert!(rig.call(chunk(0, 0, b"he", false)).error.is_none());
            }
            assert!(rig
                .call(Op::OpCancel(v1::OpCancel { op_id: ID.into() }))
                .error
                .is_none());
            assert!(rig.query().exit.unwrap().cancelled);
            assert!(rig.begin(b"hello").error.is_none());
            assert!(rig.call(chunk(1, 2, b"llo", true)).error.is_some());
            assert_eq!(std::fs::read_dir(rig.dir.path()).unwrap().count(), 0);
        }
    }

    #[test]
    fn registry_recreation_and_other_connection_have_no_adoptable_write() {
        let mut rig = Rig::new();
        assert!(rig.begin(b"hello").error.is_none());
        assert!(rig.call(chunk(0, 0, b"he", false)).error.is_none());
        let mut other = Uploads::default();
        let query = request(Op::OpQuery(v1::OpQuery { op_id: ID.into() }), 7);
        let response = other.serve(&rig.platform, &query, &|| 7);
        let Some(ResultBody::OpStatus(status)) = response.result else {
            panic!("status");
        };
        assert_eq!(status.state, v1::OpState::Lost as i32);
        assert_eq!(status.lost_reason, v1::OpLostReason::AgentRestarted as i32);
        assert!(other
            .serve(&rig.platform, &request(chunk(1, 2, b"llo", true), 7), &|| 7)
            .error
            .is_some());
        rig.uploads = Uploads::default();
        assert_eq!(rig.query().state, v1::OpState::Lost as i32);
        assert_eq!(std::fs::read_dir(rig.dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn exact_epoch_is_required_for_every_action_and_rechecked_at_commit() {
        let mut rig = Rig::new();
        assert!(rig.begin(b"hello").error.is_none());
        for epoch in [0, 6, 8] {
            for op in [
                start(b"hello"),
                chunk(0, 0, b"hello", true),
                Op::OpQuery(v1::OpQuery { op_id: ID.into() }),
                Op::OpCancel(v1::OpCancel { op_id: ID.into() }),
            ] {
                let response = rig.uploads.serve(&rig.platform, &request(op, epoch), &|| 7);
                assert_eq!(response.error.unwrap().code, v1::ErrorCode::Fenced as i32);
            }
        }
        // Epoch can change after request admission, before final publication.
        let calls = std::cell::Cell::new(0);
        let response = rig.uploads.serve(
            &rig.platform,
            &request(chunk(0, 0, b"hello", true), 7),
            &|| {
                let n = calls.get();
                calls.set(n + 1);
                if n == 0 {
                    7
                } else {
                    8
                }
            },
        );
        assert_eq!(
            response.error.unwrap().detail["failure_code"],
            "WRITE_FENCED"
        );
        assert!(!rig.dir.path().join("document").exists());
        assert_eq!(rig.query().exit.unwrap().failure_code, "WRITE_FENCED");
    }

    #[test]
    fn newer_epoch_cannot_adopt_old_registry_record() {
        let mut rig = Rig::new();
        assert!(rig.begin(b"hello").error.is_none());
        let response = rig.uploads.serve(
            &rig.platform,
            &request(chunk(0, 0, b"hello", true), 8),
            &|| 8,
        );
        assert_eq!(response.error.unwrap().code, v1::ErrorCode::Fenced as i32);
        assert!(!rig.dir.path().join("document").exists());
    }

    #[test]
    fn upload_routing_is_disjoint_from_exec_and_requires_no_stream_capability() {
        assert!(handles(&request(start(b"hello"), 7)));
        assert!(handles(&request(chunk(0, 0, b"hello", true), 7)));
        assert!(handles(&request(
            Op::OpQuery(v1::OpQuery { op_id: ID.into() }),
            7
        )));
        assert!(!handles(&request(
            Op::OpQuery(v1::OpQuery {
                op_id: "exec-synthetic".into()
            }),
            7
        )));
        assert!(!handles(&request(
            Op::OpStart(v1::OpStart {
                op: Some(v1::op_start::Op::Exec(v1::ExecRequest::default())),
                ..Default::default()
            }),
            7
        )));
        let mut rig = Rig::new();
        assert!(rig.platform.transactional_fs_write_supported());
        assert!(rig.begin(b"hello").error.is_none());
        let attach = rig.call(Op::OpAttach(v1::OpAttach {
            op_id: ID.into(),
            ..Default::default()
        }));
        assert_eq!(
            attach.error.unwrap().code,
            v1::ErrorCode::Unsupported as i32
        );
        assert!(rig.call(chunk(0, 0, b"hello", true)).error.is_none());
        assert!(rig
            .call(Op::OpCancel(v1::OpCancel { op_id: ID.into() }))
            .error
            .is_none());
        assert!(
            !rig.query().exit.unwrap().cancelled,
            "cancel after commit never undoes commit"
        );
    }
}
