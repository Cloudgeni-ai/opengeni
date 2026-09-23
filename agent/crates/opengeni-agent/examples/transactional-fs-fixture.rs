//! TEST-ONLY protobuf pipe bridge for cross-language editor integration tests.
//! Not an agent command, network listener, enrollment, or authorization surface.
//! Build explicitly with `cargo build -p opengeni-agent --example transactional-fs-fixture`.
//! Run with an existing synthetic root and nonzero epoch; stdin/stdout frames are
//! a four-byte big-endian byte length followed by generated protobuf bytes.

#[path = "../src/uploads.rs"]
mod uploads;

use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::sync::Mutex;

use opengeni_agent_platform::{NativePlatform, Platform};
use opengeni_agent_proto::v1::{self, control_request::Op, control_response::Result as ResultBody};
use prost::Message as _;

// A framing bound for this disposable test process only, not a production
// filesystem limit or host-work policy. Large-upload chunks remain <=512 KiB.
const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;

fn read_frame(reader: &mut impl Read) -> io::Result<Option<Vec<u8>>> {
    let mut header = [0_u8; 4];
    match reader.read_exact(&mut header[..1]) {
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        result => result?,
    }
    reader.read_exact(&mut header[1..])?;
    let length = usize::try_from(u32::from_be_bytes(header))
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid frame length"))?;
    if length == 0 || length > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "fixture frame outside framing bound",
        ));
    }
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes)?;
    Ok(Some(bytes))
}

fn write_frame(writer: &mut impl Write, response: &v1::ControlResponse) -> io::Result<()> {
    let length = response.encoded_len();
    if length > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "fixture response exceeds framing bound",
        ));
    }
    let length = u32::try_from(length)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid response length"))?;
    writer.write_all(&length.to_be_bytes())?;
    writer.write_all(&response.encode_to_vec())?;
    writer.flush()
}

fn error(request_id: String, code: v1::ErrorCode, message: &str) -> v1::ControlResponse {
    v1::ControlResponse {
        request_id,
        result: None,
        error: Some(v1::AgentError {
            code: code as i32,
            message: message.into(),
            retryable: false,
            ..Default::default()
        }),
    }
}

async fn serve(
    platform: &NativePlatform,
    registry: &Mutex<uploads::Uploads>,
    request: v1::ControlRequest,
    epoch: u32,
) -> v1::ControlResponse {
    if request.epoch != epoch || request.epoch == 0 {
        return error(
            request.request_id,
            v1::ErrorCode::Fenced,
            "fixture requires its exact nonzero epoch",
        );
    }
    if uploads::handles(&request) {
        // Same registry/NativePlatform as production, including poison => unknown
        // after an unexpected panic. No alternate upload implementation in tests.
        return std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            registry
                .lock()
                .expect("upload registry")
                .serve(platform, &request, &|| epoch)
        }))
        .unwrap_or_else(|_| uploads::unknown_response(request.request_id));
    }
    let result = match request.op {
        Some(Op::FsRead(op)) => platform.fs_read(&op).await.map(ResultBody::FsRead),
        Some(Op::FsWrite(op)) => platform.fs_write(&op).await.map(ResultBody::FsWrite),
        Some(Op::FsStat(op)) => platform.fs_stat(&op).await.map(ResultBody::FsStat),
        Some(Op::FsList(op)) => platform.fs_list(&op).await.map(ResultBody::FsList),
        Some(Op::FsMkdir(op)) => platform.fs_mkdir(&op).await.map(ResultBody::FsMkdir),
        Some(Op::FsMove(op)) => platform.fs_move(&op).await.map(ResultBody::FsMove),
        Some(Op::FsRemove(op)) => platform.fs_remove(&op).await.map(ResultBody::FsRemove),
        _ => {
            return error(
                request.request_id,
                v1::ErrorCode::Unsupported,
                "test fixture only serves filesystem operations",
            )
        }
    };
    match result {
        Ok(result) => v1::ControlResponse {
            request_id: request.request_id,
            result: Some(result),
            error: None,
        },
        Err(failure) => v1::ControlResponse {
            request_id: request.request_id,
            result: None,
            error: Some(failure.to_agent_error()),
        },
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args_os().skip(1);
    let root =
        PathBuf::from(args.next().ok_or("expected existing synthetic root")?).canonicalize()?;
    if !root.is_dir() || root.parent().is_none() {
        return Err("expected a dedicated existing synthetic directory".into());
    }
    let epoch: u32 = args
        .next()
        .ok_or("expected nonzero epoch")?
        .to_str()
        .ok_or("invalid epoch")?
        .parse()?;
    if epoch == 0 || args.next().is_some() {
        return Err("usage: transactional-fs-fixture <synthetic-root> <nonzero-epoch>".into());
    }
    let platform = NativePlatform::with_root(root);
    let registry = Mutex::new(uploads::Uploads::default());
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    while let Some(bytes) = read_frame(&mut input)? {
        let request = v1::ControlRequest::decode(bytes.as_slice())?;
        let response = serve(&platform, &registry, request, epoch).await;
        write_frame(&mut output, &response)?;
    }
    // Closing stdin is a normal fixture lifecycle end: drop all private staging.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn framing_rejects_oversized_empty_and_truncated_input() {
        assert!(read_frame(&mut [].as_slice()).unwrap().is_none());
        assert!(read_frame(&mut [0, 0, 0, 0].as_slice()).is_err());
        assert!(read_frame(&mut u32::MAX.to_be_bytes().as_slice()).is_err());
        assert!(read_frame(&mut [0, 0, 0, 3, 1].as_slice()).is_err());
    }

    #[test]
    fn framing_roundtrips_generated_protobuf_bytes() {
        let response = error(
            "synthetic-request".into(),
            v1::ErrorCode::Unsupported,
            "synthetic",
        );
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &response).unwrap();
        let payload = read_frame(&mut bytes.as_slice()).unwrap().unwrap();
        assert_eq!(
            v1::ControlResponse::decode(payload.as_slice()).unwrap(),
            response
        );
    }
}
