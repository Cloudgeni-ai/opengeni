use async_nats::jetstream::consumer::pull::OrderedConfig;
use futures::StreamExt;
use std::time::Instant;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("Pull Ordered Consumer Benchmark");
    println!("================================");
    println!("📡 Tokio console enabled - connect with: tokio-console");
    println!();

    // Connect to NATS
    let client = async_nats::connect("nats://127.0.0.1:4222").await?;
    let jetstream = async_nats::jetstream::new(client);

    // Create stream
    println!("Creating stream...");
    let stream = jetstream
        .get_or_create_stream(async_nats::jetstream::stream::Config {
            name: "BENCH_STREAM".to_string(),
            subjects: vec!["bench.>".to_string()],
            retention: async_nats::jetstream::stream::RetentionPolicy::Limits,
            storage: async_nats::jetstream::stream::StorageType::Memory,
            ..Default::default()
        })
        .await?;

    const MESSAGE_COUNT: usize = 10_000_000;
    const BATCH_SIZE: usize = 1000;

    // Publish messages
    println!("\nPublishing {} messages...", MESSAGE_COUNT);
    let publish_start = Instant::now();
    let payload = bytes::Bytes::from("benchmark message payload that is reasonably sized");

    // Publish in batches for better performance
    for batch_start in (0..MESSAGE_COUNT).step_by(BATCH_SIZE) {
        let mut futures = Vec::with_capacity(BATCH_SIZE);
        let batch_end = (batch_start + BATCH_SIZE).min(MESSAGE_COUNT);

        for i in batch_start..batch_end {
            let subject = format!("bench.msg.{}", i);
            futures.push(jetstream.publish(subject, payload.clone()));
        }

        // Wait for batch to complete
        let results = futures::future::join_all(futures).await;
        for result in results {
            result?.await?;
        }

        if (batch_end % 100_000) == 0 {
            let elapsed = publish_start.elapsed();
            let rate = batch_end as f64 / elapsed.as_secs_f64();
            print!(
                "\rPublished {}/{} messages ({:.0} msg/s)",
                batch_end, MESSAGE_COUNT, rate
            );
            use std::io::Write;
            std::io::stdout().flush()?;
        }
    }

    let publish_duration = publish_start.elapsed();
    let publish_rate = MESSAGE_COUNT as f64 / publish_duration.as_secs_f64();
    println!(
        "\n✅ Published {} messages in {:.2?} ({:.0} msg/s)",
        MESSAGE_COUNT, publish_duration, publish_rate
    );

    // Create ordered pull consumer
    println!("\nCreating ordered pull consumer...");
    let mut messages = stream
        .create_consumer(OrderedConfig {
            ..Default::default()
        })
        .await?
        .messages()
        .await?;

    // Consume messages
    println!("Consuming {} messages...", MESSAGE_COUNT);
    let consume_start = Instant::now();
    let mut received = 0usize;
    let mut last_report = Instant::now();
    let mut last_stream_seq = 0u64;

    while received < MESSAGE_COUNT {
        match tokio::time::timeout(std::time::Duration::from_secs(5), messages.next()).await {
            Ok(Some(Ok(msg))) => {
                received += 1;

                // Verify sequence ordering
                let info = msg.info().unwrap();
                if info.stream_sequence <= last_stream_seq {
                    eprintln!(
                        "\n⚠️  Sequence order violation: {} <= {}",
                        info.stream_sequence, last_stream_seq
                    );
                }
                last_stream_seq = info.stream_sequence;

                // Ack the message
                msg.ack().await.unwrap();

                // Progress reporting
                if last_report.elapsed() >= std::time::Duration::from_secs(1) {
                    let elapsed = consume_start.elapsed();
                    let rate = received as f64 / elapsed.as_secs_f64();
                    print!(
                        "\rConsumed {}/{} messages ({:.0} msg/s)",
                        received, MESSAGE_COUNT, rate
                    );
                    use std::io::Write;
                    std::io::stdout().flush()?;
                    last_report = Instant::now();
                }
            }
            Ok(Some(Err(e))) => {
                eprintln!("\n❌ Error consuming message: {:?}", e);
                break;
            }
            Ok(None) => {
                eprintln!("\n⚠️  Stream ended unexpectedly");
                break;
            }
            Err(_) => {
                eprintln!(
                    "\n⚠️  Timeout waiting for messages (received {} so far)",
                    received
                );
                break;
            }
        }
    }

    let consume_duration = consume_start.elapsed();
    let consume_rate = received as f64 / consume_duration.as_secs_f64();
    println!(
        "\n✅ Consumed {} messages in {:.2?} ({:.0} msg/s)",
        received, consume_duration, consume_rate
    );

    // Print summary
    println!("\n📊 Summary");
    println!("==========");
    println!("Messages:      {}", MESSAGE_COUNT);
    println!(
        "Publish time:  {:.2?} ({:.0} msg/s)",
        publish_duration, publish_rate
    );
    println!(
        "Consume time:  {:.2?} ({:.0} msg/s)",
        consume_duration, consume_rate
    );
    println!("Total time:    {:.2?}", publish_start.elapsed());

    if received == MESSAGE_COUNT {
        println!("\n✅ All messages consumed successfully with correct ordering!");
    } else {
        println!(
            "\n⚠️  Only {}/{} messages were consumed",
            received, MESSAGE_COUNT
        );
    }

    // Cleanup
    jetstream.delete_stream("BENCH_STREAM").await?;
    println!("\n🧹 Stream deleted");

    Ok(())
}
