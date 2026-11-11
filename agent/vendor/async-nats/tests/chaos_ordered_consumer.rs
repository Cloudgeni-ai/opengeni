// use async_nats::jetstream::consumer::push::OrderedConfig;
// use futures::StreamExt;

// #[tokio::test(flavor = "multi_thread")]
// async fn chaos_ordered_consumer_endless() {
//     // Connect to chaos environment at specified URL
//     let client = async_nats::connect("nats://127.0.0.1:18005")
//         .await
//         .expect("Failed to connect to NATS server");

//     let jetstream = async_nats::jetstream::new(client);

//     // Create or get stream for chaos testing
//     let stream = jetstream
//         .get_or_create_stream(async_nats::jetstream::stream::Config {
//             name: "CHAOS_TEST".to_string(),
//             subjects: vec!["chaos.>".to_string()],
//             ..Default::default()
//         })
//         .await
//         .expect("Failed to create stream");

//     // Spawn endless publisher task
//     let jetstream_publisher = jetstream.clone();
//     let publisher_handle = tokio::spawn(async move {
//         let mut seq = 0u64;
//         loop {
//             seq += 1;
//             let payload = format!("Message {}", seq);

//             match jetstream_publisher
//                 .publish("chaos.messages", payload.into())
//                 .await
//             {
//                 Ok(_) => {
//                     if seq % 100 == 0 {
//                         println!("Published {} messages", seq);
//                     }
//                 }
//                 Err(e) => {
//                     eprintln!("Publish error (will retry): {}", e);
//                     // Small delay on error before retrying
//                     tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
//                 }
//             }

//             // Small delay to avoid overwhelming the system
//             tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;
//         }
//     });

//     // Create ordered push consumer
//     let mut messages = stream
//         .create_consumer(OrderedConfig {
//             deliver_subject: "chaos_consumer".to_string(),
//             ..Default::default()
//         })
//         .await
//         .expect("Failed to create consumer")
//         .messages()
//         .await
//         .expect("Failed to get messages stream");

//     // Consume messages endlessly
//     let mut received = 0u64;
//     let start = std::time::Instant::now();

//     println!("Starting chaos test - consumer listening for messages...");
//     println!("This test will run indefinitely. Kill with Ctrl+C when done.");

//     while let Some(message) = messages.next().await {
//         match message {
//             Ok(msg) => {
//                 received += 1;

//                 // Acknowledge the message
//                 if let Err(e) = msg.ack().await {
//                     eprintln!("Failed to ack message {}: {}", received, e);
//                 }

//                 // Print progress every 100 messages
//                 if received % 100 == 0 {
//                     let elapsed = start.elapsed();
//                     let rate = received as f64 / elapsed.as_secs_f64();
//                     println!(
//                         "Received {} messages in {:?} ({:.2} msg/sec)",
//                         received, elapsed, rate
//                     );
//                 }
//             }
//             Err(e) => {
//                 // This should not happen with ordered consumer - it should recreate
//                 panic!(
//                     "Consumer error after {} messages: {:?}. Ordered consumer should recreate automatically!",
//                     received, e
//                 );
//             }
//         }
//     }

//     // Should never reach here in endless test
//     publisher_handle.abort();
// }

// #[tokio::main]
// async fn main() {
//     // Initialize logging
//     tracing_subscriber::fmt()
//         .try_init()
//         .ok();

//     println!("Connecting to chaos environment at nats://127.0.0.1:18005");

//     // Connect to chaos environment
//     let client = async_nats::connect("nats://127.0.0.1:18005")
//         .await
//         .expect("Failed to connect to NATS server");

//     let jetstream = async_nats::jetstream::new(client);

//     // Create or get stream
//     let stream = jetstream
//         .get_or_create_stream(async_nats::jetstream::stream::Config {
//             name: "CHAOS_TEST".to_string(),
//             subjects: vec!["chaos.>".to_string()],
//             ..Default::default()
//         })
//         .await
//         .expect("Failed to create stream");

//     // Spawn endless publisher
//     let jetstream_publisher = jetstream.clone();
//     tokio::spawn(async move {
//         let mut seq = 0u64;
//         loop {
//             seq += 1;
//             let payload = format!("Message {}", seq);

//             match jetstream_publisher
//                 .publish("chaos.messages", payload.into())
//                 .await
//             {
//                 Ok(_) => {
//                     if seq % 100 == 0 {
//                         println!("📤 Published {} messages", seq);
//                     }
//                 }
//                 Err(e) => {
//                     eprintln!("⚠️  Publish error (will retry): {}", e);
//                     tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
//                 }
//             }

//             tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;
//         }
//     });

//     // Create ordered push consumer
//     let mut messages = stream
//         .create_consumer(OrderedConfig {
//             deliver_subject: "chaos_consumer".to_string(),
//             ..Default::default()
//         })
//         .await
//         .expect("Failed to create consumer")
//         .messages()
//         .await
//         .expect("Failed to get messages stream");

//     // Consume messages endlessly
//     let mut received = 0u64;
//     let start = std::time::Instant::now();

//     println!("🚀 Starting chaos test - consumer listening for messages...");
//     println!("📊 This test will run indefinitely. Kill with Ctrl+C when done.");
//     println!("🔄 Ordered consumer will automatically recreate on disconnections");

//     while let Some(message) = messages.next().await {
//         match message {
//             Ok(msg) => {
//                 received += 1;

//                 // Acknowledge the message
//                 if let Err(e) = msg.ack().await {
//                     eprintln!("⚠️  Failed to ack message {}: {}", received, e);
//                 }

//                 // Print detailed progress every 100 messages
//                 if received % 100 == 0 {
//                     let elapsed = start.elapsed();
//                     let rate = received as f64 / elapsed.as_secs_f64();
//                     println!(
//                         "✅ Received {} messages in {:?} ({:.2} msg/sec)",
//                         received, elapsed, rate
//                     );
//                 }
//             }
//             Err(e) => {
//                 // This should not happen - ordered consumer should recreate
//                 eprintln!(
//                     "❌ UNEXPECTED ERROR after {} messages: {:?}",
//                     received, e
//                 );
//                 eprintln!("❌ Ordered consumer should recreate automatically!");
//                 eprintln!("❌ This indicates a bug in the ordered consumer implementation");
//                 std::process::exit(1);
//             }
//         }
//     }
// }
