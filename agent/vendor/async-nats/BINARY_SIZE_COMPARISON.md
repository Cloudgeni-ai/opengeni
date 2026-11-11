# Binary Size Comparison: Minimal vs Default Features

This comparison demonstrates the impact of optional feature flags on binary size for a simple NATS application.

## Test Application

**`examples/minimal_app.rs`** - A simple NATS client that:
- Connects to a NATS server
- Publishes a message
- Subscribes and receives one message

```rust
use async_nats;
use futures::stream::StreamExt;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = async_nats::connect("nats://localhost:4222").await?;
    client.publish("hello.world", "Hello NATS!".into()).await?;
    println!("Published message to hello.world");

    let mut subscriber = client.subscribe("hello.world").await?;
    if let Some(message) = subscriber.next().await {
        println!("Received: {:?}", std::str::from_utf8(&message.payload)?);
    }
    Ok(())
}
```

## Build Configurations

### Minimal Features
```bash
cargo build --release --example minimal_app --no-default-features --features ring
```
**Features enabled:** Only `ring` (TLS backend)
**Features excluded:** `jetstream`, `kv`, `object-store`, `service`, `nkeys`, `crypto`, `websockets`, `server_2_10`, `server_2_11`, `server_2_12`

### Default Features
```bash
cargo build --release --example minimal_app
```
**Features enabled:** All default features
```toml
default = ["server_2_10", "service", "ring", "jetstream", "nkeys", "crypto", "object-store", "kv", "websockets"]
```

## Results

### Binary Size (stripped)

| Configuration | Binary Size | Savings |
|--------------|-------------|---------|
| **Minimal Features** (ring only) | **2.9 MB** | baseline |
| **Default Features** (all enabled) | **3.3 MB** | - |
| **Reduction** | | **0.4 MB (12%)** |

### Binary Size (unstripped, with debug symbols)

| Configuration | Binary Size |
|--------------|-------------|
| Minimal Features | 3.5 MB |
| Default Features | 3.9 MB |

### Dependency Count

| Configuration | Compiled Crates | Savings |
|--------------|-----------------|---------|
| **Minimal Features** | **208 crates** | baseline |
| **Default Features** | **233 crates** | - |
| **Reduction** | | **25 crates (11%)** |

## Key Takeaways

1. **12% binary size reduction** for applications that don't need JetStream, KV, Service API, etc.
2. **11% fewer dependencies** to compile, resulting in faster build times
3. **Smaller attack surface** - fewer dependencies mean fewer potential security vulnerabilities
4. **Better for embedded/resource-constrained environments** where every MB counts

## Features and Their Impact

The excluded features add:

- **JetStream** (`jetstream`, `kv`, `object-store`): Adds `time`, `serde_nanos`, `tryhard`, `base64` dependencies
- **Service API** (`service`): Adds `time`, `serde_nanos` dependencies
- **NKeys authentication** (`nkeys`): Adds `nkeys`, `base64` dependencies
- **Crypto** (`crypto`): Adds `ring` or `aws-lc-rs` digest functions
- **WebSockets** (`websockets`): Adds WebSocket transport support

## Recommendations

For production applications:

- **Use minimal features** if you only need core NATS pub/sub
- **Enable only what you need**: If you need JetStream, enable `jetstream` but skip `service` if unused
- **Consider deployment target**: Embedded systems, WASM, and edge devices benefit most from minimal builds

## Build Commands for Different Use Cases

### Core NATS only (smallest)
```bash
cargo build --release --no-default-features --features ring
```

### Core NATS + JetStream
```bash
cargo build --release --no-default-features --features jetstream,ring
```

### Core NATS + JetStream + KV
```bash
cargo build --release --no-default-features --features kv,ring
```

### Core NATS + Service API
```bash
cargo build --release --no-default-features --features service,ring
```

### Everything (default)
```bash
cargo build --release
```
