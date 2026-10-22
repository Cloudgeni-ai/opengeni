use super::*;

#[test]
fn a_resumed_hydration_keeps_what_the_pager_has() {
    let len = 3 * CHUNK_BYTES;
    let page = 4096;
    let missing = [(page, 2 * page), (CHUNK_BYTES + page, 2 * CHUNK_BYTES)];
    let (filled, settled) = resumed(&missing, len);
    assert_eq!(settled, vec![false, false, true]);
    assert!(filled.covers(0..page));
    assert!(!filled.covers(page..2 * page));
    assert!(filled.covers(2 * page..CHUNK_BYTES + page));
    assert!(!filled.covers(CHUNK_BYTES + page..CHUNK_BYTES + 2 * page));
    assert!(filled.covers(2 * CHUNK_BYTES..len));
}

#[test]
fn arrived_chunks_are_told_as_merged_ranges() {
    let len = 4 * CHUNK_BYTES - 4096;
    assert_eq!(
        coalesce(len, [3, 0, 1, 1].into_iter()),
        vec![(0, 2 * CHUNK_BYTES), (3 * CHUNK_BYTES, len)]
    );
}

/// A pager on `control` that greets with `missing` and passes on what
/// the agent first tells it, then says the file is complete and, if
/// `done`, that it is done; it stays connected until the agent goes.
fn fake_pager(
    control: &Path,
    tag: String,
    identity: (u64, u64),
    missing: Vec<(u64, u64)>,
    done: bool,
) -> tokio::sync::oneshot::Receiver<ToPager> {
    let listener = tokio::net::UnixListener::bind(control).unwrap();
    let (pass, told) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read, mut write) = stream.into_split();
        let hello = ToHost::Hello {
            protocol: control::PROTOCOL,
            tag,
            device: identity.0,
            inode: identity.1,
            missing,
            prefetched: true,
        };
        write
            .write_all(&control::line(&hello).unwrap())
            .await
            .unwrap();
        let mut lines = BufReader::new(read).lines();
        let line = lines.next_line().await.unwrap().unwrap();
        let _ = pass.send(control::parse::<ToPager>(line.as_bytes()).unwrap());
        write
            .write_all(&control::line(&ToHost::Complete).unwrap())
            .await
            .unwrap();
        if done {
            write
                .write_all(&control::line(&ToHost::Done).unwrap())
                .await
                .unwrap();
        }
        while let Ok(Some(_)) = lines.next_line().await {}
    });
    told
}

/// A local image, its launch marker and the pager's control socket.
fn local_image(dir: &Path) -> (Images, Generation, PathBuf, PathBuf, String) {
    let images = Images::new(dir.join("images"));
    let (state, memory) = (dir.join("state"), dir.join("memory"));
    std::fs::write(&state, b"s").unwrap();
    std::fs::write(&memory, vec![7_u8; 3 * 4096]).unwrap();
    let image = images
        .publish(crate::image::Parts::Whole {
            state: &state,
            memory: &memory,
            len: 3 * 4096,
        })
        .unwrap();
    let generation = image.generation();
    let tag = tag(generation);
    let marker = dir.join("paged");
    std::fs::write(&marker, &tag).unwrap();
    (images, generation, marker, dir.join("pager.sock"), tag)
}

#[tokio::test]
async fn a_pager_that_missed_word_of_a_local_image_is_told_it_is_whole() {
    let dir = tempfile::tempdir().unwrap();
    let (images, generation, marker, control, tag) = local_image(dir.path());
    let identity = identity(&images.memory(generation)).unwrap();
    // The last fill was written but never acknowledged before the
    // agent died, and the image has since become local.
    let pager = fake_pager(&control, tag, identity, vec![(4096, 3 * 4096)], false);
    let paging = Paging::reconnect(&marker, &control, images, None)
        .await
        .unwrap()
        .expect("the pager runs");
    let told = timeout(Duration::from_secs(5), pager)
        .await
        .expect("the pager is told")
        .unwrap();
    assert_eq!(
        told,
        ToPager::Filled {
            ranges: vec![(4096, 3 * 4096)]
        }
    );
    timeout(Duration::from_secs(5), paging.complete())
        .await
        .expect("the pager says it is complete")
        .unwrap();
    paging.close().await;
}

#[tokio::test]
async fn a_conversation_that_ended_still_reads_as_complete() {
    let dir = tempfile::tempdir().unwrap();
    let (images, generation, marker, control, tag) = local_image(dir.path());
    let identity = identity(&images.memory(generation)).unwrap();
    let pager = fake_pager(&control, tag, identity, vec![(4096, 3 * 4096)], true);
    let paging = Paging::reconnect(&marker, &control, images, None)
        .await
        .unwrap()
        .expect("the pager runs");
    timeout(Duration::from_secs(5), pager)
        .await
        .expect("the pager is told")
        .unwrap();
    // Once the conversation has ended, both channels are closed and
    // either may look ready to a waiter.
    let (mut complete, mut failed) = (paging.complete.clone(), paging.failed.clone());
    timeout(Duration::from_secs(5), async {
        while complete.changed().await.is_ok() {}
        while failed.changed().await.is_ok() {}
    })
    .await
    .expect("the conversation ends");
    assert!(*complete.borrow() && !*failed.borrow());
    for _ in 0..200 {
        timeout(Duration::from_secs(1), paging.complete())
            .await
            .expect("completion is seen, whichever channel is polled first")
            .unwrap();
    }
    paging.close().await;
}

#[tokio::test]
async fn a_pager_gone_without_word_leaves_the_verdict_to_the_vmm() {
    let dir = tempfile::tempdir().unwrap();
    let (images, _, marker, control, _) = local_image(dir.path());
    // Nothing to reconnect to, done or not: the engine's adoption
    // decides from the VMM whether its memory was lost.
    for done in [false, true] {
        if done {
            std::fs::write(done_file(&control), b"").unwrap();
        }
        assert!(
            Paging::reconnect(&marker, &control, images.clone(), None)
                .await
                .unwrap()
                .is_none()
        );
    }
}

#[tokio::test]
async fn a_pager_of_an_unknown_protocol_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let control = dir.path().join("pager.sock");
    let link = Link {
        control: control.clone(),
        tag: "7".into(),
        identity: (0, 0),
        len: None,
        greeting: greeting_bytes(1 << 30, 0),
    };
    let listener = tokio::net::UnixListener::bind(&control).unwrap();
    for (protocol, accepted) in [
        (control::PROTOCOL, true),
        (control::PROTOCOL + 1, false),
        (control::OLDEST_PROTOCOL - 1, false),
    ] {
        let pager = {
            let hello = ToHost::Hello {
                protocol,
                tag: "7".into(),
                device: 1,
                inode: 2,
                missing: Vec::new(),
                prefetched: true,
            };
            let accept = listener.accept();
            async move {
                let (mut stream, _) = accept.await.unwrap();
                stream
                    .write_all(&control::line(&hello).unwrap())
                    .await
                    .unwrap();
                stream
            }
        };
        let (greeted, _stream) = tokio::join!(greet(&link), pager);
        match greeted {
            Ok(_) => assert!(accepted, "protocol {protocol} was accepted"),
            Err(Refused::Wrong(why)) => {
                assert!(!accepted, "protocol {protocol} was refused: {why}");
                assert!(why.contains("protocol"), "{why}");
            }
            Err(Refused::Gone(error)) => panic!("the pager seemed gone: {error}"),
        }
    }
}

/// A pager that greets, misses part of its image, and exits without a
/// word when told to.
fn exiting_pager(
    socket: &Path,
    tag: String,
    identity: (u64, u64),
) -> tokio::sync::oneshot::Sender<()> {
    let listener = tokio::net::UnixListener::bind(socket).unwrap();
    let socket = socket.to_owned();
    let (exit, exited) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (_read, mut write) = stream.into_split();
        let hello = ToHost::Hello {
            protocol: control::PROTOCOL,
            tag,
            device: identity.0,
            inode: identity.1,
            missing: vec![(4096, 3 * 4096)],
            prefetched: true,
        };
        write
            .write_all(&control::line(&hello).unwrap())
            .await
            .unwrap();
        let _ = exited.await;
        drop(listener);
        let _ = std::fs::remove_file(&socket);
    });
    exit
}

#[tokio::test]
async fn a_pager_ended_with_its_vm_is_not_lost_memory() {
    for ending in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let (images, generation, marker, control, tag) = local_image(dir.path());
        let identity = identity(&images.memory(generation)).unwrap();
        let exit = exiting_pager(&control, tag, identity);
        let paging = Paging::reconnect(&marker, &control, images, None)
            .await
            .unwrap()
            .expect("the pager runs");
        if ending {
            paging.ending();
        }
        exit.send(()).unwrap();
        let verdict = timeout(Duration::from_secs(5), paging.complete())
            .await
            .expect("the conversation ends");
        // Only a pager that went while its VM was meant to go on
        // running means memory that can no longer be served.
        if ending {
            assert!(matches!(verdict, Err(Incomplete::Stopped)), "{verdict:?}");
            assert!(!*paging.failed.borrow());
        } else {
            assert!(matches!(verdict, Err(Incomplete::Failed)), "{verdict:?}");
        }
        paging.close().await;
    }
}

#[test]
fn launch_tags_name_their_generation() {
    let generation = Generation::parse("00000000000000a7").unwrap();
    let tag = tag(generation);
    assert_eq!(generation_of(&tag), Some(generation));
    assert_ne!(tag, super::tag(generation));
    assert_eq!(generation_of("00000000000000a7"), None);
}

#[tokio::test]
async fn a_line_longer_than_its_bound_is_refused_before_it_is_held() {
    let (agent, pager) = tokio::net::UnixStream::pair().unwrap();
    let (read, _write) = agent.into_split();
    let mut frames = Frames::new(read);
    let (_pager_read, mut pager) = pager.into_split();
    // A line read in part survives a read that gave up waiting.
    pager.write_all(b"{\"want\":{\"offset\":0,").await.unwrap();
    assert!(
        timeout(Duration::from_millis(50), frames.next(MESSAGE_BYTES))
            .await
            .is_err()
    );
    pager
        .write_all(b"\"len\":4096,\"urgent\":true}}\n")
        .await
        .unwrap();
    let line = frames.next(MESSAGE_BYTES).await.unwrap().unwrap();
    assert_eq!(
        control::parse::<ToHost>(&line).unwrap(),
        ToHost::Want {
            offset: 0,
            len: 4096,
            urgent: true
        }
    );
    // Megabytes without a newline: refused after the bound, and the
    // rest is never read.
    let flood = tokio::spawn(async move {
        let spaces = vec![b' '; 64 << 10];
        let mut sent = 0_usize;
        while sent < 8 << 20 {
            if pager.write_all(&spaces).await.is_err() {
                break;
            }
            sent += spaces.len();
        }
    });
    let error = frames.next(MESSAGE_BYTES).await.unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert!(frames.line.capacity() <= MESSAGE_BYTES + 1);
    drop(frames);
    flood.abort();
}

#[test]
fn a_greeting_names_ordered_ranges_inside_the_image() {
    let len = Some(3 * 4096);
    assert!(plausible(&[], len));
    assert!(plausible(&[(0, 4096), (8192, 3 * 4096)], len));
    assert!(plausible(&[(0, u64::MAX)], None));
    assert!(!plausible(&[(0, 4 * 4096)], len));
    assert!(!plausible(&[(4096, 4096)], len));
    assert!(!plausible(&[(8192, 3 * 4096), (0, 4096)], len));
    assert!(!plausible(&[(0, 8192), (4096, 3 * 4096)], len));
}

#[tokio::test]
async fn a_pager_whose_greeting_cannot_be_true_is_not_believed() {
    let dir = tempfile::tempdir().unwrap();
    let (images, generation, marker, control, tag) = local_image(dir.path());
    let (device, inode) = identity(&images.memory(generation)).unwrap();
    let outside = ToHost::Hello {
        protocol: control::PROTOCOL,
        tag: tag.clone(),
        device,
        inode,
        missing: vec![(0, 1 << 40)],
        prefetched: false,
    };
    let crowded = ToHost::Hello {
        protocol: control::PROTOCOL,
        tag,
        device,
        inode,
        missing: (0..100)
            .map(|page| (page * 8192, page * 8192 + 4096))
            .collect(),
        prefetched: false,
    };
    for hello in [outside, crowded] {
        let _ = std::fs::remove_file(&control);
        let listener = tokio::net::UnixListener::bind(&control).unwrap();
        // Greets every attempt the same way, and hangs up.
        let pager = tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let _ = stream.write_all(&control::line(&hello).unwrap()).await;
            }
        });
        let refused = Paging::reconnect(&marker, &control, images.clone(), None)
            .await
            .unwrap_err();
        assert_eq!(refused.kind, ErrorKind::Transient);
        pager.abort();
    }
}
