use async_nats::jetstream::consumer::{Config, DeliverPolicy};

fn main() {
    // Test 1: Can we create a Config with time types?
    #[cfg(feature = "time-crate")]
    {
        use time::OffsetDateTime;
        let config = Config {
            deliver_policy: DeliverPolicy::ByStartTime {
                start_time: OffsetDateTime::now_utc(),
            },
            ..Default::default()
        };
        println!(
            "Created config with time::OffsetDateTime: {:?}",
            config.deliver_policy
        );
    }

    #[cfg(feature = "chrono-crate")]
    {
        use chrono::Utc;
        let config = Config {
            deliver_policy: DeliverPolicy::ByStartTime {
                start_time: Utc::now().fixed_offset(),
            },
            ..Default::default()
        };
        println!(
            "Created config with chrono::DateTime: {:?}",
            config.deliver_policy
        );
    }

    println!("Compilation successful!");
}
