//! Lab-only single-client NBD bridge to verified lazy object chunks.
//!
//! Writes go to a fresh local sparse COW file; its in-memory sector bitmap is
//! NOT recoverable after daemon loss. This is a latency prototype, not a durable
//! write backend. It never modifies uploaded snapshots. Disconnect before exit.
#[cfg(unix)]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use compute_storage::{
        lazy::LazyReader,
        manifest::DiskManifest,
        store::{ChunkStore, provider_from_env},
    };
    use object_store::path::Path;
    use std::{env, fs::OpenOptions, os::unix::net::UnixListener, sync::Arc};
    let args: Vec<_> = env::args().collect();
    if args.len() != 6 {
        eprintln!("usage: storage-nbd PROVIDER PREFIX MANIFEST SOCKET NEW_COW_FILE");
        std::process::exit(2);
    }
    let runtime = tokio::runtime::Runtime::new()?;
    // Builders may initialize HTTP clients and therefore need a runtime context.
    let _guard = runtime.enter();
    let manifest = DiskManifest::decode(&std::fs::read(&args[3])?)?;
    let reader = Arc::new(LazyReader::new(
        manifest,
        ChunkStore::new(provider_from_env(&args[1])?, Path::from(args[2].as_str())),
        512 * 1024 * 1024,
    )?);
    if let Some(path) = env::var_os("STORAGE_PREFETCH") {
        prefetch(&runtime, &reader, &path)?;
    }
    let cow = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(&args[5])?;
    cow.set_len(reader.disk_len())?;
    let listener = UnixListener::bind(&args[4])?;
    if let Some(path) = env::var_os("STORAGE_PREFETCH_BACKGROUND") {
        let offsets = serde_json::from_slice(&std::fs::read(path)?)?;
        let reader = reader.clone();
        runtime.spawn(async move {
            if prefetch_offsets(&reader, offsets, "prefetch-background")
                .await
                .is_err()
            {
                eprintln!("background prefetch failed; demand reads still verify objects");
            }
        });
    }
    let (mut socket, _) = listener.accept()?;
    negotiate(&mut socket, reader.disk_len())?;
    serve(&runtime, &reader, &cow, &mut socket)
}

#[cfg(unix)]
fn serve(
    runtime: &tokio::runtime::Runtime,
    reader: &compute_storage::lazy::LazyReader,
    cow: &std::fs::File,
    socket: &mut std::os::unix::net::UnixStream,
) -> Result<(), Box<dyn std::error::Error>> {
    use serde_json::json;
    use std::{
        collections::HashSet,
        env,
        io::{Read, Write},
        os::unix::fs::FileExt,
        time::Instant,
    };
    let mut dirty = HashSet::new();
    let started = Instant::now();
    let mut requests = 0_u64;
    let mut reads = 0_u64;
    loop {
        let mut header = [0; 28];
        if let Err(error) = socket.read_exact(&mut header) {
            if error.kind() == std::io::ErrorKind::UnexpectedEof {
                break;
            }
            return Err(error.into());
        }
        let magic = u32::from_be_bytes(header[0..4].try_into()?);
        let flags_type = u32::from_be_bytes(header[4..8].try_into()?);
        let offset = u64::from_be_bytes(header[16..24].try_into()?);
        let length = u32::from_be_bytes(header[24..28].try_into()?) as usize;
        let operation = flags_type & 0xffff;
        let io_started = Instant::now();
        if env::var_os("STORAGE_TRACE").is_some() {
            println!(
                "{}",
                json!({"event":"request","operation":operation,"offset":offset,"length":length,"elapsed_ms":started.elapsed().as_secs_f64()*1000.0})
            );
        }
        if magic != 0x2560_9513
            || length > 32 * 1024 * 1024
            || offset
                .checked_add(length as u64)
                .is_none_or(|end| end > reader.disk_len())
            || !offset.is_multiple_of(512)
            || !length.is_multiple_of(512)
        {
            return Err("invalid NBD request".into());
        }
        if operation == 2 {
            break;
        }
        let mut bytes = vec![0; length];
        let result: Result<(), Box<dyn std::error::Error>> = (|| {
            match operation {
                0 => {
                    reads += 1;
                    read_overlay(runtime, reader, cow, &dirty, offset, &mut bytes)?;
                }
                1 => {
                    socket.read_exact(&mut bytes)?;
                    cow.write_all_at(&bytes, offset)?;
                    dirty.extend(offset / 512..(offset + length as u64) / 512);
                    if flags_type & 0x1_0000 != 0 {
                        cow.sync_data()?;
                    }
                }
                3 => cow.sync_data()?,
                _ => return Err("unsupported NBD command".into()),
            }
            Ok(())
        })();
        socket.write_all(&0x6744_6698_u32.to_be_bytes())?;
        socket.write_all(&(if result.is_ok() { 0_u32 } else { 5_u32 }).to_be_bytes())?;
        socket.write_all(&header[8..16])?;
        if result.is_ok() && operation == 0 {
            socket.write_all(&bytes)?;
        }
        if result.is_err() {
            eprintln!("object-backed NBD I/O failed");
        }
        if env::var_os("STORAGE_TRACE").is_some() {
            println!(
                "{}",
                json!({"event":"complete","operation":operation,"offset":offset,"length":length,"ms":io_started.elapsed().as_secs_f64()*1000.0,"fetched":reader.fetched()})
            );
        }
        requests += 1;
        if requests.is_multiple_of(100) {
            let (objects, fetched_bytes) = reader.fetched();
            println!(
                "{}",
                json!({"requests":requests,"reads":reads,"objects":objects,"fetched_bytes":fetched_bytes,"elapsed_ms":started.elapsed().as_secs_f64()*1000.0})
            );
        }
    }
    println!(
        "{}",
        json!({"final":true,"requests":requests,"reads":reads,"fetched":reader.fetched()})
    );
    Ok(())
}

#[cfg(unix)]
fn read_overlay(
    runtime: &tokio::runtime::Runtime,
    reader: &compute_storage::lazy::LazyReader,
    cow: &std::fs::File,
    dirty: &std::collections::HashSet<u64>,
    offset: u64,
    bytes: &mut [u8],
) -> Result<(), Box<dyn std::error::Error>> {
    use std::os::unix::fs::FileExt;
    let sectors = offset / 512..(offset + bytes.len() as u64) / 512;
    if !sectors.clone().all(|sector| dirty.contains(&sector)) {
        runtime.block_on(reader.read(offset, bytes))?;
    }
    for (i, sector) in sectors.enumerate() {
        if dirty.contains(&sector) {
            cow.read_exact_at(&mut bytes[i * 512..(i + 1) * 512], sector * 512)?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn prefetch(
    runtime: &tokio::runtime::Runtime,
    reader: &compute_storage::lazy::LazyReader,
    path: &std::ffi::OsStr,
) -> Result<(), Box<dyn std::error::Error>> {
    let offsets: Vec<u64> = serde_json::from_slice(&std::fs::read(path)?)?;
    runtime.block_on(prefetch_offsets(reader, offsets, "prefetch"))?;
    Ok(())
}

#[cfg(unix)]
async fn prefetch_offsets(
    reader: &compute_storage::lazy::LazyReader,
    offsets: Vec<u64>,
    event: &str,
) -> compute_storage::Result<()> {
    use futures::{StreamExt, TryStreamExt, stream};
    let started = std::time::Instant::now();
    stream::iter(offsets)
        .map(|offset| async move {
            let mut byte = [0];
            reader.read(offset, &mut byte).await
        })
        .buffer_unordered(64)
        .try_collect::<Vec<_>>()
        .await?;
    println!(
        "{}",
        serde_json::json!({"event":event,"ms":started.elapsed().as_secs_f64()*1000.0,"fetched":reader.fetched()})
    );
    Ok(())
}

#[cfg(unix)]
fn negotiate(
    socket: &mut std::os::unix::net::UnixStream,
    size: u64,
) -> Result<(), Box<dyn std::error::Error>> {
    use std::io::{Read, Write};
    socket.write_all(b"NBDMAGIC")?;
    socket.write_all(&0x4948_4156_454f_5054_u64.to_be_bytes())?;
    socket.write_all(&3_u16.to_be_bytes())?; // FIXED_NEWSTYLE | NO_ZEROES
    let mut flags = [0; 4];
    socket.read_exact(&mut flags)?;
    let client_flags = u32::from_be_bytes(flags);
    if client_flags & !3 != 0 {
        return Err("unsupported client flags".into());
    }
    for _ in 0..128 {
        let mut header = [0; 16];
        socket.read_exact(&mut header)?;
        let magic = u64::from_be_bytes(header[..8].try_into()?);
        let option = u32::from_be_bytes(header[8..12].try_into()?);
        let length = u32::from_be_bytes(header[12..].try_into()?) as usize;
        if magic != 0x4948_4156_454f_5054 || length > 4096 {
            return Err("invalid NBD option".into());
        }
        let mut payload = vec![0; length];
        socket.read_exact(&mut payload)?;
        if option == 1 {
            socket.write_all(&size.to_be_bytes())?;
            socket.write_all(&13_u16.to_be_bytes())?; // HAS_FLAGS | SEND_FLUSH | SEND_FUA
            if client_flags & 2 == 0 {
                socket.write_all(&[0; 124])?;
            }
            return Ok(());
        }
        if option == 7 || option == 6 {
            if payload.len() < 6 {
                return Err("invalid NBD GO payload".into());
            }
            let name_length = u32::from_be_bytes(payload[..4].try_into()?) as usize;
            if name_length + 6 > payload.len() {
                return Err("invalid NBD export name".into());
            }
            let mut export = Vec::new();
            export.extend_from_slice(&0_u16.to_be_bytes());
            export.extend_from_slice(&size.to_be_bytes());
            export.extend_from_slice(&13_u16.to_be_bytes());
            option_reply(socket, option, 3, &export)?;
            let mut blocks = Vec::new();
            blocks.extend_from_slice(&3_u16.to_be_bytes());
            for value in [512_u32, 4096, 32 * 1024 * 1024] {
                blocks.extend_from_slice(&value.to_be_bytes());
            }
            option_reply(socket, option, 3, &blocks)?;
            option_reply(socket, option, 1, &[])?;
            if option == 7 {
                return Ok(());
            }
        } else if option == 3 {
            option_reply(socket, option, 2, &0_u32.to_be_bytes())?;
            option_reply(socket, option, 1, &[])?;
        } else if option == 2 {
            option_reply(socket, option, 1, &[])?;
            return Err("client aborted negotiation".into());
        } else {
            option_reply(socket, option, 0x8000_0001, &[])?;
        }
    }
    Err("NBD negotiation did not complete".into())
}

#[cfg(unix)]
fn option_reply(
    socket: &mut std::os::unix::net::UnixStream,
    option: u32,
    kind: u32,
    payload: &[u8],
) -> std::io::Result<()> {
    use std::io::Write;
    socket.write_all(&0x0003_e889_0455_65a9_u64.to_be_bytes())?;
    socket.write_all(&option.to_be_bytes())?;
    socket.write_all(&kind.to_be_bytes())?;
    socket.write_all(
        &u32::try_from(payload.len())
            .map_err(|_| std::io::Error::other("oversized option reply"))?
            .to_be_bytes(),
    )?;
    socket.write_all(payload)
}

#[cfg(not(unix))]
fn main() {
    eprintln!("Unix sockets required");
    std::process::exit(2);
}

#[cfg(all(test, unix))]
mod tests {
    use super::read_overlay;
    use compute_storage::{
        chunk::EncodedChunk,
        lazy::LazyReader,
        manifest::{DiskManifest, Extent, ExtentSource},
        store::ChunkStore,
    };
    use object_store::{memory::InMemory, path::Path};
    use std::{collections::HashSet, os::unix::fs::FileExt, sync::Arc};

    #[test]
    fn sector_overlay_preserves_clean_bytes_and_skips_fully_dirty_fetches() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let store = ChunkStore::new(Arc::new(InMemory::new()), Path::from("test"));
        let chunk = EncodedChunk::encode(&[3; 1024], 1).unwrap();
        runtime.block_on(store.put_chunk(&chunk)).unwrap();
        let manifest = DiskManifest {
            version: 1,
            disk_len: 1024,
            base_len: 0,
            base_digest: "0".repeat(64),
            extents: vec![Extent {
                offset: 0,
                length: 1024,
                source: ExtentSource::Chunk {
                    reference: chunk.reference,
                    offset: 0,
                },
            }],
        };
        let reader = LazyReader::new(manifest.clone(), store, 0).unwrap();
        let cow = tempfile::tempfile().unwrap();
        cow.set_len(1024).unwrap();
        cow.write_all_at(&[9; 512], 512).unwrap();
        let dirty = HashSet::from([1]);
        let mut bytes = [0; 1024];
        read_overlay(&runtime, &reader, &cow, &dirty, 0, &mut bytes).unwrap();
        assert_eq!(bytes[..512], [3; 512]);
        assert_eq!(bytes[512..], [9; 512]);
        let missing = LazyReader::new(
            manifest,
            ChunkStore::new(Arc::new(InMemory::new()), Path::from("missing")),
            0,
        )
        .unwrap();
        let mut dirty_bytes = [0; 512];
        read_overlay(&runtime, &missing, &cow, &dirty, 512, &mut dirty_bytes).unwrap();
        assert_eq!(dirty_bytes, [9; 512]);
        assert_eq!(missing.fetched(), (0, 0));
    }
}
