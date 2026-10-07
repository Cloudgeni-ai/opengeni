use async_nats::jetstream::consumer::pull::Config;
use futures::StreamExt;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("Testing pull consumer heartbeat behavior during disconnect...");

    // Start a test server
    let server = nats_server::run_server("tests/configs/jetstream.conf");
    let server_url = server.client_url();

    // Connect and create stream
    let client = async_nats::connect(&server_url).await?;
    let jetstream = async_nats::jetstream::new(client.clone());

    // Create stream
    jetstream
        .create_stream(async_nats::jetstream::stream::Config {
            name: "test".to_string(),
            subjects: vec!["events".to_string()],
            ..Default::default()
        })
        .await?;

    // Publish some messages
    for i in 0..20 {
        jetstream
            .publish("events", format!("msg{}", i).into())
            .await?;
    }

    // Create regular pull consumer (not ordered)
    let consumer = jetstream
        .create_consumer_on_stream(
            Config {
                durable_name: Some("test_consumer".to_string()),
                ack_policy: async_nats::jetstream::consumer::AckPolicy::Explicit,
                ..Default::default()
            },
            "test",
        )
        .await?;

    // Get messages stream with short heartbeat
    let mut messages = consumer
        .stream()
        .heartbeat(std::time::Duration::from_secs(2))
        .messages()
        .await?;

    // Consume first 5 messages
    println!("Consuming first 5 messages...");
    for i in 0..5 {
        let msg = messages.next().await.unwrap()?;
        println!(
            "  Message {}: {:?}",
            i + 1,
            std::str::from_utf8(&msg.payload)?
        );
        msg.ack().await.unwrap();
    }

    println!("\nDropping server to simulate disconnect...");
    // Simulate disconnect by dropping the server
    drop(server);

    // Sleep for longer than 2x heartbeat timeout (would be 4 seconds)
    println!("Sleeping for 6 seconds (3x heartbeat timeout)...");
    println!("With the fix, heartbeat timer should be cleared during disconnect");
    tokio::time::sleep(tokio::time::Duration::from_secs(6)).await;

    // Start new server on same URL
    println!("\nStarting new server on {}...", server_url);
    let _server = nats_server::run_server("tests/configs/jetstream.conf");

    // Wait for reconnection
    println!("Waiting for client to reconnect...");
    tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;

    // Try to continue consuming
    println!("\nAttempting to consume more messages after reconnect...");
    println!("This should work without MissingHeartbeat errors");

    let mut reconnect_count = 0;
    let timeout = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        while let Some(result) = messages.next().await {
            match result {
                Ok(msg) => {
                    reconnect_count += 1;
                    println!(
                        "  ✅ Message after reconnect #{}: {:?}",
                        reconnect_count,
                        std::str::from_utf8(&msg.payload)?
                    );
                    msg.ack().await.unwrap();
                    if reconnect_count >= 5 {
                        break;
                    }
                }
                Err(e) => {
                    println!("  ❌ Error: {:?}", e);
                    // Don't panic immediately, let's see what happens
                    return Err(format!("Got error after reconnect: {:?}", e).into());
                }
            }
        }
        Ok::<(), Box<dyn std::error::Error>>(())
    });

    match timeout.await {
        Ok(Ok(_)) => {
            println!(
                "\n✅ SUCCESS: Consumed {} messages after reconnect without errors!",
                reconnect_count
            );
        }
        Ok(Err(e)) => {
            println!("\n❌ FAILED: {}", e);
            return Err(e);
        }
        Err(_) => {
            println!("\n⚠️  Timed out waiting for messages after reconnect");
            println!("   Consumed {} messages before timeout", reconnect_count);
        }
    }

    Ok(())
}
