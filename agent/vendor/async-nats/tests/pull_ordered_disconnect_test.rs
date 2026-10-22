// use async_nats::jetstream::consumer::pull::OrderedConfig;
// use futures::StreamExt;

// #[tokio::test]
// async fn pull_ordered_no_heartbeat_timeout_during_disconnect() {
//     // Start a test server
//     let server = nats_server::run_server("tests/configs/jetstream.conf");

//     // Connect and create stream
//     let client = async_nats::connect(server.client_url()).await.unwrap();
//     let jetstream = async_nats::jetstream::new(client.clone());

//     jetstream
//         .create_stream(async_nats::jetstream::stream::Config {
//             name: "test".to_string(),
//             subjects: vec!["events".to_string()],
//             ..Default::default()
//         })
//         .await
//         .unwrap();

//     // Publish some messages
//     for i in 0..10 {
//         jetstream
//             .publish("events", format!("msg{}", i).into())
//             .await
//             .unwrap();
//     }

//     // Get stream handle
//     let stream = jetstream.get_stream("test").await.unwrap();

//     // Create ordered pull consumer and get messages stream directly
//     let mut messages = stream
//         .create_consumer(OrderedConfig {
//             ..Default::default()
//         })
//         .await
//         .unwrap()
//         .messages()
//         .await
//         .unwrap();

//     // Consume first 5 messages
//     for _ in 0..5 {
//         let msg = messages.next().await.unwrap().unwrap();
//         msg.ack().await.unwrap();
//     }

//     println!("Consumed 5 messages, now simulating disconnect by dropping server");

//     // Simulate disconnect by dropping the server
//     drop(server);

//     // Sleep for longer than heartbeat timeout (ordered consumer uses 15s heartbeat)
//     // 2x heartbeat timeout would be 30 seconds, but we want to test that it doesn't timeout
//     // even when disconnected for longer than the heartbeat interval
//     println!("Sleeping for 20 seconds (longer than heartbeat but less than 2x)...");
//     tokio::time::sleep(tokio::time::Duration::from_secs(20)).await;

//     // Start new server on same port
//     println!("Starting new server...");
//     let server = nats_server::run_server("tests/configs/jetstream.conf");

//     // Wait for client to reconnect
//     println!("Waiting for client to reconnect...");
//     tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

//     // Publish more messages
//     let client = async_nats::connect(server.client_url()).await.unwrap();
//     let jetstream = async_nats::jetstream::new(client);

//     for i in 10..15 {
//         jetstream
//             .publish("events", format!("msg{}", i).into())
//             .await
//             .unwrap();
//     }

//     println!("Published 5 more messages after reconnect");

//     // Try to consume remaining messages
//     // This should work without MissingHeartbeat errors
//     let mut count = 0;
//     while let Some(result) = messages.next().await {
//         match result {
//             Ok(msg) => {
//                 println!("Got message: {:?}", std::str::from_utf8(&msg.payload));
//                 msg.ack().await.unwrap();
//                 count += 1;
//                 if count >= 10 {
//                     break;
//                 }
//             }
//             Err(e) => {
//                 panic!(
//                     "Should not get error during disconnect/reconnect cycle, but got: {:?}",
//                     e
//                 );
//             }
//         }
//     }

//     println!("Successfully consumed {} messages total", 5 + count);
//     assert_eq!(count, 10, "Should have consumed all remaining messages");
// }
