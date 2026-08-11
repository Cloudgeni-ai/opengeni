//! Placement-local native ComputerSession helper process.

#[tokio::main]
async fn main() {
    if let Err(error) = opengeni_computer_native::run_native_rpc().await {
        eprintln!("opengeni-computer-native: {error}");
        std::process::exit(1);
    }
}
