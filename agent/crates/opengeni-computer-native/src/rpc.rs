use std::io::ErrorKind;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{
    AsyncRead, AsyncReadExt as _, AsyncWrite, AsyncWriteExt as _, BufReader, BufWriter,
};
use tokio::sync::{Mutex, Semaphore};
use tokio::task::JoinSet;

use crate::{
    open_native_adapter, ComputerAdapter, NativeActionCommand, NativeAdapterError,
    NativeAdapterErrorCode, NativeCapturedFrame,
};

/// Current native-helper wire protocol.
pub const NATIVE_RPC_PROTOCOL_VERSION: u16 = 1;

const MAX_REQUEST_BYTES: usize = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES: usize = 64 * 1024 * 1024;
const MAX_REQUEST_ID_BYTES: usize = 128;
const MAX_IN_FLIGHT_REQUESTS: usize = 64;
const MAX_IN_FLIGHT_CAPTURES: usize = 2;

/// Fatal native-helper protocol/transport failure. Individual adapter failures
/// are returned on the wire and do not stop the helper.
#[derive(Debug, thiserror::Error)]
pub enum NativeRpcServerError {
    /// Standard input/output transport failed.
    #[error("native helper transport failed: {0}")]
    Transport(#[from] std::io::Error),
    /// A peer sent an invalid or oversized frame.
    #[error("native helper protocol failed: {0}")]
    Protocol(String),
    /// A request task panicked or was cancelled.
    #[error("native helper request task failed: {0}")]
    Task(#[from] tokio::task::JoinError),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeRequest {
    protocol_version: u16,
    request_id: String,
    #[serde(flatten)]
    operation: NativeOperation,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "method",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum NativeOperation {
    Handshake,
    Capabilities,
    Targets,
    Observe { target_id: String },
    Capture { target_id: String },
    Validate { command: NativeActionCommand },
    Dispatch { command: NativeActionCommand },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeResponse {
    protocol_version: u16,
    request_id: String,
    #[serde(flatten)]
    body: NativeResponseBody,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum NativeResponseBody {
    Ok { result: Value },
    Error { error: NativeWireError },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeWireError {
    code: NativeAdapterErrorCode,
    message: String,
    retryable: bool,
    dispatched: bool,
}

struct NativeHandledResponse {
    response: NativeResponse,
    attachment: Option<Vec<u8>>,
}

struct NativeResponsePayload {
    result: Value,
    attachment: Option<Vec<u8>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeFrameMetadata {
    frame_id: String,
    target_id: String,
    target_generation: String,
    width: u32,
    height: u32,
    mime_type: String,
    sha256: String,
    attachment_bytes: usize,
}

impl From<NativeAdapterError> for NativeWireError {
    fn from(error: NativeAdapterError) -> Self {
        Self {
            code: error.code,
            message: error.message,
            retryable: error.retryable,
            dispatched: error.dispatched,
        }
    }
}

/// Runs the native helper on length-prefixed stdin/stdout frames.
///
/// # Errors
///
/// Returns only when the process transport/protocol fails or the platform
/// adapter cannot be opened. Adapter request failures remain typed responses.
pub async fn run_native_rpc() -> Result<(), NativeRpcServerError> {
    let adapter = open_native_adapter().await.map_err(|error| {
        NativeRpcServerError::Protocol(format!("native adapter initialization failed: {error}"))
    })?;
    serve(
        Arc::from(adapter),
        BufReader::new(tokio::io::stdin()),
        BufWriter::new(tokio::io::stdout()),
    )
    .await
}

async fn serve<R, W>(
    adapter: Arc<dyn ComputerAdapter>,
    mut input: R,
    output: W,
) -> Result<(), NativeRpcServerError>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Send + Unpin + 'static,
{
    let writer = Arc::new(Mutex::new(output));
    let permits = Arc::new(Semaphore::new(MAX_IN_FLIGHT_REQUESTS));
    let capture_permits = Arc::new(Semaphore::new(MAX_IN_FLIGHT_CAPTURES));
    let mut tasks = JoinSet::<Result<(), NativeRpcServerError>>::new();

    loop {
        tokio::select! {
            completed = tasks.join_next(), if !tasks.is_empty() => {
                if let Some(result) = completed {
                    result??;
                }
            }
            frame = read_frame(&mut input, MAX_REQUEST_BYTES) => {
                let Some(frame) = frame? else {
                    break;
                };
                let request = decode_request(&frame)?;
                let permit = Arc::clone(&permits).acquire_owned().await.map_err(|_| {
                    NativeRpcServerError::Protocol("native helper concurrency gate closed".to_string())
                })?;
                let request_adapter = Arc::clone(&adapter);
                let request_writer = Arc::clone(&writer);
                let request_capture_permits = Arc::clone(&capture_permits);
                tasks.spawn(async move {
                    let _permit = permit;
                    let _capture_permit = if matches!(&request.operation, NativeOperation::Capture { .. }) {
                        Some(request_capture_permits.acquire_owned().await.map_err(|_| {
                            NativeRpcServerError::Protocol(
                                "native capture concurrency gate closed".to_string(),
                            )
                        })?)
                    } else {
                        None
                    };
                    let handled = handle_request(request_adapter.as_ref(), request).await;
                    let bytes = serde_json::to_vec(&handled.response).map_err(|error| {
                        NativeRpcServerError::Protocol(format!("encode native response: {error}"))
                    })?;
                    let mut output = request_writer.lock().await;
                    write_frame(&mut *output, &bytes, MAX_RESPONSE_BYTES).await?;
                    if let Some(attachment) = handled.attachment {
                        write_frame(&mut *output, &attachment, MAX_ATTACHMENT_BYTES).await?;
                    }
                    Ok(())
                });
            }
        }
    }

    while let Some(result) = tasks.join_next().await {
        result??;
    }
    Ok(())
}

fn decode_request(frame: &[u8]) -> Result<NativeRequest, NativeRpcServerError> {
    let request: NativeRequest = serde_json::from_slice(frame).map_err(|error| {
        NativeRpcServerError::Protocol(format!("decode native request: {error}"))
    })?;
    if request.request_id.is_empty()
        || request.request_id.len() > MAX_REQUEST_ID_BYTES
        || !request.request_id.is_ascii()
    {
        return Err(NativeRpcServerError::Protocol(
            "native request id must be 1-128 ASCII bytes".to_string(),
        ));
    }
    Ok(request)
}

async fn handle_request(
    adapter: &dyn ComputerAdapter,
    request: NativeRequest,
) -> NativeHandledResponse {
    let request_id = request.request_id;
    if request.protocol_version != NATIVE_RPC_PROTOCOL_VERSION {
        return NativeHandledResponse {
            response: error_response(
                request_id,
                NativeAdapterError::definite(
                    NativeAdapterErrorCode::InvalidAction,
                    format!(
                        "unsupported native protocol {}; expected {}",
                        request.protocol_version, NATIVE_RPC_PROTOCOL_VERSION
                    ),
                    false,
                ),
            ),
            attachment: None,
        };
    }

    let result = match request.operation {
        NativeOperation::Handshake => Ok(payload(json!({
            "protocolVersion": NATIVE_RPC_PROTOCOL_VERSION,
            "helperVersion": env!("CARGO_PKG_VERSION"),
            "platform": std::env::consts::OS,
            "capabilities": adapter.capabilities(),
        }))),
        NativeOperation::Capabilities => serialize_result(adapter.capabilities()).map(payload),
        NativeOperation::Targets => match adapter.targets().await {
            Ok(targets) => serialize_result(targets).map(payload),
            Err(error) => Err(error),
        },
        NativeOperation::Observe { target_id } => match adapter.observe(&target_id).await {
            Ok(observation) => serialize_result(observation).map(payload),
            Err(error) => Err(error),
        },
        NativeOperation::Capture { target_id } => {
            adapter.capture(&target_id).await.and_then(frame_payload)
        }
        NativeOperation::Validate { command } => adapter
            .validate(&command)
            .await
            .map(|()| payload(Value::Null)),
        NativeOperation::Dispatch { command } => match adapter.dispatch(&command).await {
            Ok(observation) => serialize_result(observation).map(payload),
            Err(error) => Err(error),
        },
    };

    match result {
        Ok(payload) => NativeHandledResponse {
            response: NativeResponse {
                protocol_version: NATIVE_RPC_PROTOCOL_VERSION,
                request_id,
                body: NativeResponseBody::Ok {
                    result: payload.result,
                },
            },
            attachment: payload.attachment,
        },
        Err(error) => NativeHandledResponse {
            response: error_response(request_id, error),
            attachment: None,
        },
    }
}

fn payload(result: Value) -> NativeResponsePayload {
    NativeResponsePayload {
        result,
        attachment: None,
    }
}

fn frame_payload(frame: NativeCapturedFrame) -> Result<NativeResponsePayload, NativeAdapterError> {
    if frame.bytes.is_empty() || frame.bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err(NativeAdapterError::definite(
            NativeAdapterErrorCode::DriverFailed,
            "native frame is empty or exceeds the attachment envelope",
            true,
        ));
    }
    let metadata = NativeFrameMetadata {
        frame_id: frame.frame_id,
        target_id: frame.target_id,
        target_generation: frame.target_generation,
        width: frame.width,
        height: frame.height,
        mime_type: frame.mime_type,
        sha256: frame.sha256,
        attachment_bytes: frame.bytes.len(),
    };
    Ok(NativeResponsePayload {
        result: serialize_result(metadata)?,
        attachment: Some(frame.bytes),
    })
}

fn serialize_result(value: impl Serialize) -> Result<Value, NativeAdapterError> {
    serde_json::to_value(value).map_err(|error| {
        NativeAdapterError::definite(
            NativeAdapterErrorCode::DriverFailed,
            format!("serialize native result: {error}"),
            false,
        )
    })
}

fn error_response(request_id: String, error: NativeAdapterError) -> NativeResponse {
    NativeResponse {
        protocol_version: NATIVE_RPC_PROTOCOL_VERSION,
        request_id,
        body: NativeResponseBody::Error {
            error: error.into(),
        },
    }
}

async fn read_frame<R>(
    input: &mut R,
    max_bytes: usize,
) -> Result<Option<Vec<u8>>, NativeRpcServerError>
where
    R: AsyncRead + Unpin,
{
    let mut header = [0_u8; 4];
    match input.read(&mut header[..1]).await {
        Ok(0) => return Ok(None),
        Ok(1) => {}
        Ok(_) => unreachable!("one-byte read returned more than one byte"),
        Err(error) => return Err(error.into()),
    }
    input.read_exact(&mut header[1..]).await.map_err(|error| {
        if error.kind() == ErrorKind::UnexpectedEof {
            NativeRpcServerError::Protocol("truncated native frame header".to_string())
        } else {
            error.into()
        }
    })?;
    let length = usize::try_from(u32::from_be_bytes(header)).map_err(|_| {
        NativeRpcServerError::Protocol("native frame length exceeds this platform".to_string())
    })?;
    if length == 0 || length > max_bytes {
        return Err(NativeRpcServerError::Protocol(format!(
            "native frame length {length} is outside 1..={max_bytes}"
        )));
    }
    let mut frame = vec![0_u8; length];
    input.read_exact(&mut frame).await.map_err(|error| {
        if error.kind() == ErrorKind::UnexpectedEof {
            NativeRpcServerError::Protocol("truncated native frame body".to_string())
        } else {
            error.into()
        }
    })?;
    Ok(Some(frame))
}

async fn write_frame<W>(
    output: &mut W,
    bytes: &[u8],
    max_bytes: usize,
) -> Result<(), NativeRpcServerError>
where
    W: AsyncWrite + Unpin,
{
    if bytes.is_empty() || bytes.len() > max_bytes {
        return Err(NativeRpcServerError::Protocol(format!(
            "native response length {} is outside 1..={max_bytes}",
            bytes.len()
        )));
    }
    let length = u32::try_from(bytes.len()).map_err(|_| {
        NativeRpcServerError::Protocol("native response length exceeds u32".to_string())
    })?;
    output.write_all(&length.to_be_bytes()).await?;
    output.write_all(bytes).await?;
    output.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use async_trait::async_trait;
    use serde_json::Value;
    use sha2::{Digest as _, Sha256};
    use tokio::io::{duplex, split, AsyncWriteExt as _};

    use super::*;
    use crate::{
        NativeAdapterResult, NativeCapabilities, NativeCapturedFrame, NativeObservation,
        NativeTarget,
    };

    struct MockAdapter;

    #[async_trait]
    impl ComputerAdapter for MockAdapter {
        fn capabilities(&self) -> NativeCapabilities {
            NativeCapabilities {
                semantic_observation: true,
                app_discovery: true,
                app_launch: false,
                window_capture: false,
                screen_capture: false,
                semantic_actions: true,
                pointer_input: false,
                keyboard_input: false,
                background_actions: true,
                parallel_apps: true,
            }
        }

        async fn targets(&self) -> NativeAdapterResult<Vec<NativeTarget>> {
            Ok(Vec::new())
        }

        async fn observe(&self, _target_id: &str) -> NativeAdapterResult<NativeObservation> {
            Err(NativeAdapterError::unsupported("not used"))
        }

        async fn capture(&self, target_id: &str) -> NativeAdapterResult<NativeCapturedFrame> {
            let bytes = b"frame".to_vec();
            Ok(NativeCapturedFrame {
                frame_id: "f_test".to_string(),
                target_id: target_id.to_string(),
                target_generation: "g_test".to_string(),
                width: 1,
                height: 1,
                mime_type: "image/png".to_string(),
                sha256: hex::encode(Sha256::digest(&bytes)),
                bytes,
            })
        }

        async fn validate(&self, _command: &NativeActionCommand) -> NativeAdapterResult<()> {
            Err(NativeAdapterError::unsupported("not used"))
        }

        async fn dispatch(
            &self,
            _command: &NativeActionCommand,
        ) -> NativeAdapterResult<NativeObservation> {
            Err(NativeAdapterError::unsupported("not used"))
        }
    }

    #[tokio::test]
    async fn serves_correlated_length_prefixed_handshake() {
        let (client, server) = duplex(16 * 1024);
        let (mut client_read, mut client_write) = split(client);
        let (server_read, server_write) = split(server);
        let task = tokio::spawn(serve(Arc::new(MockAdapter), server_read, server_write));
        let request = serde_json::to_vec(&json!({
            "protocolVersion": NATIVE_RPC_PROTOCOL_VERSION,
            "requestId": "r_test",
            "method": "handshake",
        }))
        .expect("serialize request");
        write_frame(&mut client_write, &request, MAX_REQUEST_BYTES)
            .await
            .expect("write request");
        let response = read_frame(&mut client_read, MAX_RESPONSE_BYTES)
            .await
            .expect("read response")
            .expect("response frame");
        let response: Value = serde_json::from_slice(&response).expect("decode response");
        assert_eq!(response["requestId"], "r_test");
        assert_eq!(response["status"], "ok");
        assert_eq!(response["result"]["platform"], std::env::consts::OS);
        client_write.shutdown().await.expect("close request stream");
        task.await.expect("server task").expect("server result");
    }

    #[tokio::test]
    async fn rejects_oversized_frames_before_allocation() {
        let (mut client, mut server) = duplex(64);
        client
            .write_all(&u32::MAX.to_be_bytes())
            .await
            .expect("write header");
        let error = read_frame(&mut server, MAX_REQUEST_BYTES)
            .await
            .expect_err("oversized frame must fail");
        assert!(error.to_string().contains("outside"));
    }

    #[tokio::test]
    async fn sends_capture_metadata_then_one_correlated_binary_attachment() {
        let (client, server) = duplex(16 * 1024);
        let (mut client_read, mut client_write) = split(client);
        let (server_read, server_write) = split(server);
        let task = tokio::spawn(serve(Arc::new(MockAdapter), server_read, server_write));
        let request = serde_json::to_vec(&json!({
            "protocolVersion": NATIVE_RPC_PROTOCOL_VERSION,
            "requestId": "r_capture",
            "method": "capture",
            "targetId": "screen:test",
        }))
        .expect("serialize request");
        write_frame(&mut client_write, &request, MAX_REQUEST_BYTES)
            .await
            .expect("write request");
        let response = read_frame(&mut client_read, MAX_RESPONSE_BYTES)
            .await
            .expect("read response")
            .expect("response frame");
        let response: Value = serde_json::from_slice(&response).expect("decode response");
        assert_eq!(response["requestId"], "r_capture");
        assert_eq!(response["result"]["attachmentBytes"], 5);
        let attachment = read_frame(&mut client_read, MAX_ATTACHMENT_BYTES)
            .await
            .expect("read attachment")
            .expect("attachment frame");
        assert_eq!(attachment, b"frame");
        client_write.shutdown().await.expect("close request stream");
        task.await.expect("server task").expect("server result");
    }
}
