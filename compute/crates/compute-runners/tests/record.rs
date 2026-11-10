//! The wrapper every command runs under, run by bash as envd runs it.

use std::process::{Command, Output};

use compute_runners::compute::RECORDED;

#[test]
fn a_command_records_its_start_then_its_exit_code() {
    let record =
        std::env::temp_dir().join(format!("compute-runners-record-{}", std::process::id()));
    let run = |script: &str| -> Output {
        Command::new("/bin/bash")
            .args(["-c", RECORDED, "compute-runners"])
            .arg(&record)
            .arg(script)
            .env("GIVEN", "it's \"given\"")
            .output()
            .unwrap()
    };
    // The command's environment, output and exit code pass through, and
    // its exit code is recorded.
    let ran = run(r#"printf '%s\n' "$GIVEN"; exit 3"#);
    assert_eq!(ran.status.code(), Some(3));
    assert_eq!(String::from_utf8_lossy(&ran.stdout), "it's \"given\"\n");
    assert_eq!(std::fs::read_to_string(&record).unwrap(), "3");
    // While it runs, the record says it started.
    let ran = run(&format!("cat '{}'", record.display()));
    assert_eq!(ran.status.code(), Some(0));
    assert_eq!(String::from_utf8_lossy(&ran.stdout), "started");
    assert_eq!(std::fs::read_to_string(&record).unwrap(), "0");
    std::fs::remove_file(&record).unwrap();
}
