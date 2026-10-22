// Copyright 2020-2022 The NATS Authors
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

use bytes::Bytes;
use std::env;
use std::time::Instant;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Get subject length from command line argument
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage: {} <subject_length>", args[0]);
        eprintln!("Example: {} 10", args[0]);
        std::process::exit(1);
    }

    let subject_len: usize = args[1].parse()?;

    // Leak the string to make it 'static - this is what makes it fast!
    // The benchmark uses "bench" which is &'static str, so we do the same
    let subject: &'static str = Box::leak("a".repeat(subject_len).into_boxed_str());

    println!("Connecting to NATS on localhost:4222...");
    let client = async_nats::connect("nats://localhost:4222").await?;

    println!("Publishing 100,000,000 messages...");
    println!("Subject length: {} bytes", subject_len);
    println!("Payload size: 0 bytes");
    println!();

    let msg_count = 100_000_000;
    let payload = Bytes::new();

    let start = Instant::now();

    // Exact same pattern as benchmarks/core_nats.rs line 187
    for _ in 0..msg_count {
        client.publish(subject, payload.clone()).await?;
    }

    // Flush to ensure all messages are sent
    client.flush().await?;

    let duration = start.elapsed();
    let duration_secs = duration.as_secs_f64();
    let msgs_per_sec = msg_count as f64 / duration_secs;
    let throughput_mbps = (msgs_per_sec * subject_len as f64) / (1024.0 * 1024.0);

    println!("=== Results ===");
    println!("Total messages: {}", msg_count);
    println!("Duration: {:.2}s", duration_secs);
    println!("Messages/sec: {:.2}", msgs_per_sec);
    println!("Throughput: {:.2} MB/s", throughput_mbps);

    Ok(())
}
