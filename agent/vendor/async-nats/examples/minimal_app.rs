// Simple NATS client that connects and publishes a message
use async_nats;
use futures::stream::StreamExt;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Connect to NATS server
    let client = async_nats::connect("nats://localhost:4222").await?;

    // Publish a message
    client.publish("hello.world", "Hello NATS!".into()).await?;

    println!("Published message to hello.world");

    // Subscribe and receive one message
    let mut subscriber = client.subscribe("hello.world").await?;

    if let Some(message) = subscriber.next().await {
        println!("Received: {:?}", std::str::from_utf8(&message.payload)?);
    }

    Ok(())
}
