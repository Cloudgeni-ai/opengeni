use async_nats::jetstream::consumer::pull::OrderedConfig;
use futures::StreamExt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize logging (simplified without env filter)
    tracing_subscriber::fmt().try_init().ok();

    println!("🔌 Connecting to chaos environment at nats://127.0.0.1:18005");

    // Connect to chaos environment
    let client = async_nats::connect("nats://127.0.0.1:18005").await?;

    let jetstream = async_nats::jetstream::new(client);

    // Create or get stream
    println!("📦 Creating/getting stream CHAOS_TEST");
    let stream = jetstream
        .get_or_create_stream(async_nats::jetstream::stream::Config {
            name: "CHAOS_TEST".to_string(),
            subjects: vec!["chaos.>".to_string()],
            retention: async_nats::jetstream::stream::RetentionPolicy::Limits,
            max_messages: 100_000, // Keep last 100k messages
            ..Default::default()
        })
        .await?;

    let published = Arc::new(AtomicU64::new(0));
    let published_clone = published.clone();

    // Spawn endless publisher
    let jetstream_publisher = jetstream.clone();
    tokio::spawn(async move {
        let mut seq = 0u64;
        let mut last_error_time = None;

        loop {
            seq += 1;
            let payload = format!("Message {}", seq);

            match jetstream_publisher
                .publish("chaos.messages", payload.into())
                .await
            {
                Ok(_) => {
                    published_clone.store(seq, Ordering::Relaxed);
                    if seq % 1000 == 0 {
                        println!("📤 Published {} messages", seq);
                    }
                    last_error_time = None;
                }
                Err(e) => {
                    let now = std::time::Instant::now();
                    // Only log errors once per second to avoid spam
                    if last_error_time
                        .is_none_or(|t: std::time::Instant| now.duration_since(t).as_secs() >= 1)
                    {
                        eprintln!("⚠️  Publish error: {} (will keep retrying)", e);
                        last_error_time = Some(now);
                    }
                    // Back off on error
                    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
                }
            }

            // Small delay between publishes
            tokio::time::sleep(tokio::time::Duration::from_millis(5)).await;
        }
    });

    // Create ordered push consumer
    println!("🎯 Creating ordered push consumer");
    let mut messages = stream
        .create_consumer(OrderedConfig {
            // deliver_subject: "chaos_consumer".to_string(),
            ..Default::default()
        })
        .await?
        .messages()
        .await?;

    // Stats tracking
    let mut received = 0u64;
    let mut last_stream_seq: Option<u64> = None;
    let mut duplicate_count = 0u64;
    let start = std::time::Instant::now();
    let mut last_report = std::time::Instant::now();

    println!("🚀 Starting chaos test - consumer listening for messages...");
    println!("📊 Press Ctrl+C to stop the test");
    println!("🔄 Ordered consumer will automatically recreate on disconnections");
    println!("{}", "-".repeat(60));

    while let Some(message) = messages.next().await {
        match message {
            Ok(msg) => {
                received += 1;

                // Get the stream sequence from the message info
                let stream_seq = msg.info().unwrap().stream_sequence;

                // Check for gaps or duplicates in stream sequence
                if let Some(last_seq) = last_stream_seq {
                    if stream_seq == last_seq {
                        // Same sequence - not a gap, likely a redelivery
                        duplicate_count += 1;
                    } else if stream_seq != last_seq + 1 {
                        // Gap detected - this should never happen with ordered consumer
                        eprintln!("{}", "-".repeat(60));
                        eprintln!("❌ FATAL: Gap detected in stream sequence!");
                        eprintln!("❌ Last stream sequence: {}", last_seq);
                        eprintln!("❌ Current stream sequence: {}", stream_seq);
                        eprintln!(
                            "❌ Missing sequences: {} to {}",
                            last_seq + 1,
                            stream_seq - 1
                        );
                        eprintln!(
                            "❌ Ordered consumer should have recreated from sequence {}!",
                            last_seq + 1
                        );
                        eprintln!("{}", "-".repeat(60));

                        // Log final statistics
                        let elapsed = start.elapsed();
                        let rate = received as f64 / elapsed.as_secs_f64();
                        eprintln!("📊 Final stats before failure:");
                        eprintln!("   Total received: {}", received);
                        eprintln!("   Total published: {}", published.load(Ordering::Relaxed));
                        eprintln!("   Runtime: {:?}", elapsed);
                        eprintln!("   Average rate: {:.2} msg/s", rate);
                        eprintln!("   Duplicate deliveries: {}", duplicate_count);

                        std::process::exit(1);
                    }
                }

                last_stream_seq = Some(stream_seq);

                // Acknowledge the message
                if let Err(e) = msg.ack().await {
                    eprintln!("⚠️  Failed to ack message {}: {}", received, e);
                }

                // Print detailed progress every second
                let now = std::time::Instant::now();
                if now.duration_since(last_report).as_secs() >= 1 {
                    let elapsed = start.elapsed();
                    let rate = received as f64 / elapsed.as_secs_f64();
                    let pub_count = published.load(Ordering::Relaxed);
                    let lag = pub_count.saturating_sub(received);

                    println!(
                        "✅ Received: {} | Published: {} | Lag: {} | Rate: {:.1} msg/s | Stream Seq: {} | Dups: {}",
                        received, pub_count, lag, rate, stream_seq, duplicate_count
                    );
                    last_report = now;
                }
            }
            Err(e) => {
                // This should not happen - ordered consumer should recreate
                eprintln!("{}", "-".repeat(60));
                eprintln!("❌ UNEXPECTED ERROR after {} messages: {:?}", received, e);
                eprintln!("❌ Ordered consumer should recreate automatically!");
                eprintln!("❌ This indicates a bug in the ordered consumer implementation");
                eprintln!("{}", "-".repeat(60));

                // Log final statistics
                let elapsed = start.elapsed();
                let rate = received as f64 / elapsed.as_secs_f64();
                eprintln!("📊 Final stats:");
                eprintln!("   Total received: {}", received);
                eprintln!("   Total published: {}", published.load(Ordering::Relaxed));
                eprintln!("   Runtime: {:?}", elapsed);
                eprintln!("   Average rate: {:.2} msg/s", rate);
                eprintln!("   Duplicate deliveries: {}", duplicate_count);
                if let Some(seq) = last_stream_seq {
                    eprintln!("   Last stream sequence: {}", seq);
                }

                std::process::exit(1);
            }
        }
    }

    Ok(())
}
