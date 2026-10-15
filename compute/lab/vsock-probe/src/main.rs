//! Measures a NATS control link from inside a sandbox VM over vsock.
//!
//! In the guest: `vsock-probe serve PORT SUBJECT`
//!   Dials the host's vsock PORT, which the host agent relays to a NATS
//!   server, answers requests on SUBJECT, and reports connect time,
//!   reconnects and its own memory use on stdout.
//!   With `NOTICE_PORT` set it also listens there for the host's restore
//!   notice (`restored <unix nanos>`): it sets the clock, answers `ok` and
//!   reconnects, since the old connection died with the old VM process.
//!
//! On the host: `vsock-probe ping URL SUBJECT [ROUNDS]`
//!   Requests SUBJECT every 2 ms until it is answered and prints the time to
//!   the first answer (which includes waking a sleeping sandbox), then the
//!   round-trip times of ROUNDS more requests.

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use async_nats::{Client, ConnectOptions, Event};
use futures_util::StreamExt;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio_vsock::{VMADDR_CID_ANY, VMADDR_CID_HOST, VsockAddr, VsockListener, VsockStream};

type Error = Box<dyn std::error::Error + Send + Sync>;

fn wall_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn rss_kib() -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|status| {
            status
                .lines()
                .find_map(|line| line.strip_prefix("VmRSS:"))
                .and_then(|value| value.trim().trim_end_matches("kB").trim().parse().ok())
        })
        .unwrap_or(0)
}

/// Sets the wall clock to `nanos` since the Unix epoch.
fn set_clock(nanos: u128) -> std::io::Result<()> {
    let time = libc::timespec {
        tv_sec: (nanos / 1_000_000_000) as libc::time_t,
        tv_nsec: (nanos % 1_000_000_000) as libc::c_long,
    };
    // SAFETY: `time` is a valid timespec for the duration of the call.
    if unsafe { libc::clock_settime(libc::CLOCK_REALTIME, &time) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// Serves the host's restore notices for as long as the probe runs.
async fn notices(port: u32, client: Client) -> Result<(), Error> {
    let listener = VsockListener::bind(VsockAddr::new(VMADDR_CID_ANY, port))?;
    loop {
        let (stream, _) = listener.accept().await?;
        let client = client.clone();
        tokio::spawn(async move {
            let received = Instant::now();
            let (read, mut write) = tokio::io::split(stream);
            let mut line = String::new();
            if BufReader::new(read).read_line(&mut line).await.is_err() {
                return;
            }
            let Some(nanos) = line
                .trim()
                .strip_prefix("restored ")
                .and_then(|nanos| nanos.parse::<u128>().ok())
            else {
                return;
            };
            let behind_ms = (nanos as f64 / 1e6) - wall_ms() as f64;
            if let Err(error) = set_clock(nanos) {
                println!("event=clock_error error={error}");
            }
            let _ = write.write_all(b"ok\n").await;
            let acked_us = received.elapsed().as_micros();
            // The old link is a dead socket; replace it now rather than when
            // the next keepalive happens to fail.
            let requested = client.force_reconnect().await;
            println!(
                "event=restored wall_ms={} clock_was_behind_ms={behind_ms:.0} acked_us={acked_us} reconnect_requested={}",
                wall_ms(),
                requested.is_ok()
            );
        });
    }
}

async fn serve(port: u32, subject: String) -> Result<(), Error> {
    let started = Instant::now();
    let client = ConnectOptions::new()
        .ignore_discovered_servers()
        .retry_on_initial_connect()
        .reconnect_delay_callback(|attempts| Duration::from_millis(attempts.min(200) as u64))
        .event_callback(|event| async move {
            let name = match event {
                Event::Connected => "connected",
                Event::Disconnected => "disconnected",
                _ => return,
            };
            println!("event={name} wall_ms={}", wall_ms());
        })
        .custom_dialer(move |_| async move {
            VsockStream::connect(VsockAddr::new(VMADDR_CID_HOST, port)).await
        })
        .connect("nats://host:4222")
        .await?;
    let mut requests = client.subscribe(subject).await?;
    client.flush().await?;
    if let Some(notice_port) = std::env::var("NOTICE_PORT").ok().and_then(|p| p.parse().ok()) {
        let client = client.clone();
        tokio::spawn(async move {
            if let Err(error) = notices(notice_port, client).await {
                println!("event=notice_error error={error}");
            }
        });
    }
    println!(
        "ready connect_ms={:.2} rss_kib={}",
        started.elapsed().as_secs_f64() * 1000.0,
        rss_kib()
    );
    while let Some(request) = requests.next().await {
        if let Some(reply) = request.reply {
            client.publish(reply, request.payload).await?;
        }
    }
    Ok(())
}

async fn ping(url: String, subject: String, rounds: usize) -> Result<(), Error> {
    let client = async_nats::connect(url).await?;
    let started = Instant::now();
    let mut attempts = 0_u32;
    loop {
        attempts += 1;
        let answer = tokio::time::timeout(
            Duration::from_millis(500),
            client.request(subject.clone(), "ping".into()),
        )
        .await;
        if matches!(answer, Ok(Ok(_))) {
            break;
        }
        if started.elapsed() > Duration::from_secs(60) {
            return Err("no answer within 60 s".into());
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    let first = started.elapsed();
    let mut times = Vec::with_capacity(rounds);
    for _ in 0..rounds {
        let sent = Instant::now();
        client.request(subject.clone(), "ping".into()).await?;
        times.push(sent.elapsed().as_secs_f64() * 1000.0);
    }
    times.sort_by(f64::total_cmp);
    let at = |q: f64| {
        times
            .get(((times.len() as f64 - 1.0) * q).round() as usize)
            .copied()
            .unwrap_or(0.0)
    };
    println!(
        "first_answer_ms={:.2} attempts={attempts} rtt_p50_ms={:.3} rtt_p99_ms={:.3}",
        first.as_secs_f64() * 1000.0,
        at(0.5),
        at(0.99)
    );
    Ok(())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Error> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["serve", port, subject] => serve(port.parse()?, (*subject).to_owned()).await,
        ["ping", url, subject] => ping((*url).to_owned(), (*subject).to_owned(), 0).await,
        ["ping", url, subject, rounds] => {
            ping((*url).to_owned(), (*subject).to_owned(), rounds.parse()?).await
        }
        _ => Err("usage: vsock-probe serve PORT SUBJECT | ping URL SUBJECT [ROUNDS]".into()),
    }
}
